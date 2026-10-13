import copy
import os
import shutil
import subprocess
import unittest

import yaml
from check_msa import ROOT, SERVICES, argo_errors, policy_errors, render

HELM = os.environ.get("HELM", "helm")


@unittest.skipUnless(shutil.which(HELM), "Install the pinned Helm CLI for render tests")
class MsaChartTests(unittest.TestCase):
    def test_four_services(self):
        for service in SERVICES:
            with self.subTest(service=service):
                self.assertEqual(policy_errors(service, render(service, HELM)), [])

    def test_web_reuses_service_chart_without_database_secrets_or_migration(self):
        resources = render("web", HELM)
        self.assertEqual({r["kind"] for r in resources}, {"Deployment", "Service"})
        pod = next(r for r in resources if r["kind"] == "Deployment")["spec"]["template"]["spec"]
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertEqual(pod["securityContext"]["runAsUser"], 101)
        container = pod["containers"][0]
        self.assertEqual(container["image"], "govbiz-web:local-k8s")
        self.assertNotIn("env", container)
        self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
        self.assertEqual(container["volumeMounts"], [{"name": "tmp", "mountPath": "/tmp"}])
        for probe in ("startupProbe", "readinessProbe", "livenessProbe"):
            self.assertEqual(container[probe]["httpGet"]["path"], "/healthz")
        with self.assertRaises(subprocess.CalledProcessError):
            render("web", HELM, ["--set", "localMode=false"])
        published = render("web", HELM, ["--set", "localMode=false", "--set", "image.digest=sha256:" + "a" * 64])
        published_pod = next(r for r in published if r["kind"] == "Deployment")["spec"]["template"]["spec"]
        self.assertIn("@sha256:", published_pod["containers"][0]["image"])

    def test_reject_unsafe_values(self):
        for arguments in (
            ["--set", "replicas=2"],
            ["--set", "image.tag=latest"],
            ["--set", "localMode=false"],
            ["--set", "image.digest=sha256:bad"],
            ["--set", "env.OPENAI_API_KEY=not-a-real-secret"],
            ["--set", "serviceName=unknown"],
        ):
            with self.subTest(arguments=arguments), self.assertRaises(subprocess.CalledProcessError):
                render("core-service", HELM, arguments)

    def test_digest_mode(self):
        resources = render("core-service", HELM, ["--set", "localMode=false", "--set", "image.digest=sha256:" + "a" * 64])
        self.assertEqual(policy_errors("core-service", resources), [])

    def trace_resources(self):
        return render("ops-service", HELM, [
            "--values", str(ROOT / "environments/in-cluster/ops-service.yaml"),
            "--set-string", "image.digest=sha256:" + "a" * 64,
        ])

    def test_ops_traces_default_off_and_dedicated_credentials_match_all_containers(self):
        for resource in render("ops-service", HELM):
            if resource["kind"] in {"Deployment", "Job"}:
                for container in resource["spec"]["template"]["spec"]["containers"]:
                    self.assertFalse(any(entry["name"].startswith("LANGFUSE_")
                                         for entry in container["env"]))
        resources = self.trace_resources()
        self.assertEqual(policy_errors("ops-service", resources, ops_sync_enabled=True), [])
        checked = []
        for resource in resources:
            if resource["kind"] in {"Deployment", "Job"}:
                for container in resource["spec"]["template"]["spec"]["containers"]:
                    checked.append(container["name"])
                    entries = {entry["name"]: entry for entry in container["env"]}
                    for key in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"):
                        self.assertEqual(entries[key], {"name": key, "valueFrom": {
                            "secretKeyRef": {"name": "ops-langfuse", "key": key}}})
                    self.assertEqual(entries["DB_PASSWORD"]["valueFrom"]["secretKeyRef"]["name"],
                                     "ops-runtime")
        self.assertCountEqual(checked, ["ops-service", "ops-sync", "ops-migrate"])

    def test_ops_traces_reject_wrong_service_non_boolean_and_duplicate_keys(self):
        for service, args in (
            ("core-service", ["--set", "opsTraces.enabled=true"]),
            ("web", ["--set", "opsTraces.enabled=true"]),
            ("ops-service", ["--set-string", "opsTraces.enabled=false"]),
            ("ops-service", ["--set-string", "opsTraces.enabled=true"]),
            ("ops-service", ["--set", "opsTraces.enabled=true", "--set-string",
                             "env.LANGFUSE_PUBLIC_KEY=duplicate"]),
            ("ops-service", ["--set", "opsTraces.enabled=true", "--set-json",
                             'secretKeys=["DJANGO_SECRET_KEY","DB_PASSWORD","LANGFUSE_SECRET_KEY"]']),
        ):
            with self.subTest(service=service, args=args), self.assertRaises(subprocess.CalledProcessError):
                render(service, HELM, args)

    def test_ops_trace_policy_rejects_wrong_refs_literals_partial_or_duplicate_credentials(self):
        original = self.trace_resources()
        for mutation in ("wrong-secret", "wrong-key", "optional", "plaintext", "partial",
                         "duplicate", "unrelated-key", "missing-runtime"):
            resources = copy.deepcopy(original)
            for resource in resources:
                if resource["kind"] not in {"Deployment", "Job"}:
                    continue
                for container in resource["spec"]["template"]["spec"]["containers"]:
                    entries = container["env"]
                    entry = next(e for e in entries if e["name"] == "LANGFUSE_SECRET_KEY")
                    reference = entry["valueFrom"]["secretKeyRef"]
                    if mutation == "wrong-secret":
                        reference["name"] = "core-runtime"
                    elif mutation == "wrong-key":
                        reference["key"] = "DB_PASSWORD"
                    elif mutation == "optional":
                        reference["optional"] = True
                    elif mutation == "plaintext":
                        entry.pop("valueFrom")
                        entry["value"] = "not-a-project-key"
                    elif mutation == "partial":
                        entries.remove(entry)
                    elif mutation == "duplicate":
                        entries.append(copy.deepcopy(entry))
                    elif mutation == "unrelated-key":
                        next(e for e in entries if e["name"] == "DB_PASSWORD")["valueFrom"]["secretKeyRef"]["name"] = "ops-langfuse"
                    elif mutation == "missing-runtime":
                        container["env"] = [e for e in entries if e.get("valueFrom", {}).get("secretKeyRef", {}).get("name") != "ops-runtime"]
            with self.subTest(mutation=mutation):
                self.assertTrue(policy_errors("ops-service", resources, ops_sync_enabled=True))

    def test_other_services_cannot_reference_ops_trace_secret(self):
        for service in ("core-service", "catalog-service", "ai-service"):
            resources = render(service, HELM)
            container = next(r for r in resources if r["kind"] == "Deployment")["spec"]["template"]["spec"]["containers"][0]
            next(e for e in container["env"] if "valueFrom" in e)["valueFrom"]["secretKeyRef"]["name"] = "ops-langfuse"
            with self.subTest(service=service):
                self.assertIn(service + ": service-scoped secret required", policy_errors(service, resources))

    def test_private_registry_uses_secret_reference_only(self):
        resources = render("ai-service", HELM, ["--set", "imagePullSecrets[0].name=ghcr-pull"])
        deployment = next(r for r in resources if r["kind"] == "Deployment")
        self.assertEqual(deployment["spec"]["template"]["spec"]["imagePullSecrets"], [{"name": "ghcr-pull"}])
        self.assertFalse(any(r["kind"] == "Secret" for r in resources))
        with self.assertRaises(subprocess.CalledProcessError):
            render("ai-service", HELM, ["--set-json", 'imagePullSecrets=[{"name":""}]'])

    def test_only_selected_service_changes(self):
        baseline = {s: render(s, HELM) for s in SERVICES}
        changed = copy.deepcopy(baseline)
        changed["ai-service"] = render("ai-service", HELM, ["--set", "image.tag=independent-v2"])
        self.assertEqual([s for s in SERVICES if changed[s] != baseline[s]], ["ai-service"])

    def test_ops_declares_core_auth_and_unconnected_evaluation_explicitly(self):
        from check_portfolio import free_runtime_errors
        resources = render("ops-service", HELM)
        deployment = next(item for item in resources if item["kind"] == "Deployment")
        env = {entry["name"]: entry.get("value") for entry in deployment["spec"]["template"]["spec"]["containers"][0]["env"]}
        self.assertEqual(env["CORE_API_URL"], "http://core-service:8080")
        self.assertEqual(env["DJANGO_COOKIE_SECURE"], "false")
        self.assertEqual(env["LLMOPS_EVIDENCE_DIR"], "/evaluation-data")
        self.assertEqual(env["LLMOPS_RESULTS_DIR"], "/results")
        self.assertEqual(env["PREFECT_API_URL"], "http://disabled-prefect.invalid/api")
        self.assertEqual(free_runtime_errors("ops-service", {"env": env}), [])
        self.assertTrue(free_runtime_errors("ops-service", {"env": {**env, "LLMOPS_LIVE_ENABLED": "true"}}))

    def test_writer_policy_detects_regression(self):
        resources = render("core-service", HELM, ["--set-string", "env.BIZINFO_SYNC_ENABLED=true"])
        self.assertIn("core-service: Core source writer enabled", policy_errors("core-service", resources))

    def test_catalog_endpoint_requires_the_same_internal_service(self):
        resources = render("core-service", HELM)
        pod = next(r for r in resources if r["kind"] == "Deployment")["spec"]["template"]["spec"]
        endpoint = next(e for e in pod["containers"][0]["env"] if e["name"] == "CATALOG_SERVICE_URL")
        for url in ("http://catalog-service:8081", "http://catalog-service.govbiz-msa.svc.cluster.local:8081"):
            endpoint["value"] = url
            self.assertEqual(policy_errors("core-service", resources), [])
        for url in ("http://localhost:8081", "http://host.docker.internal:8081",
                    "http://catalog-service.other.svc.cluster.local:8081",
                    "http://catalog-service.govbiz-msa.svc.cluster.local:8081.evil.invalid"):
            with self.subTest(url=url):
                endpoint["value"] = url
                self.assertIn("core-service: wrong Catalog endpoint", policy_errors("core-service", resources))

    def test_local_data_requires_explicit_opt_in(self):
        result = subprocess.run([HELM, "template", "local-data", str(ROOT / "charts/govbiz-local-data")], capture_output=True, check=False)
        self.assertNotEqual(result.returncode, 0)

    def test_local_data_has_six_independent_persistent_stores(self):
        output = subprocess.check_output([HELM, "template", "local-data", str(ROOT / "charts/govbiz-local-data"),
                                          "--namespace", "govbiz-msa", "--set", "allowDisposableData=true"], text=True)
        resources = list(yaml.safe_load_all(output))
        stores = [r for r in resources if r["kind"] == "StatefulSet"]
        self.assertEqual({r["metadata"]["name"] for r in stores},
                         {"core-mysql", "catalog-mysql", "ops-mysql", "redis", "qdrant", "elasticsearch"})
        for store in stores:
            self.assertEqual(store["spec"]["persistentVolumeClaimRetentionPolicy"], {"whenDeleted": "Retain", "whenScaled": "Retain"})
            self.assertEqual(len(store["spec"]["volumeClaimTemplates"]), 1)
        self.assertFalse(any(r["kind"] == "Secret" for r in resources))


class ArgoDefinitionTests(unittest.TestCase):
    def test_restricted_local_definitions(self):
        self.assertEqual(argo_errors(), [])


if __name__ == "__main__":
    unittest.main()
