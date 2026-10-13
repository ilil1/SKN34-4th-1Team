"""Offline rendering of Compose-free connections and externally restored storage."""

import copy
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import yaml

from check_evaluation import render_bundle
from check_msa import ROOT, SERVICES, policy_errors, render

HELM = os.environ.get("HELM", "helm")
PROFILE = ROOT / "environments/in-cluster"
STORES = ("core-mysql", "catalog-mysql", "ops-mysql", "redis", "qdrant", "elasticsearch")
DIGEST = "@sha256:" + "a" * 64


def retained_values():
    values = yaml.safe_load((ROOT / "charts/govbiz-local-data/values.yaml").read_text())
    values["existingClaims"] = {name: name + "-restored" for name in STORES}
    values["mysqlImage"] += DIGEST
    for store in values["stores"].values():
        store["image"] += DIGEST
        store["pullPolicy"] = "IfNotPresent"
    values["rabbitmq"]["image"] += DIGEST
    return values


def render_data(values):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "values.yaml"
        path.write_text(yaml.safe_dump(values))
        output = subprocess.check_output(
            [HELM, "template", "data", str(ROOT / "charts/govbiz-local-data"),
             "--namespace", "govbiz-msa", "--values", str(path)],
            text=True, stderr=subprocess.PIPE,
        )
    return [row for row in yaml.safe_load_all(output) if row]


@unittest.skipUnless(shutil.which(HELM), "Install the pinned Helm CLI for render tests")
class RetainedDataTests(unittest.TestCase):
    def test_restored_stores_reference_distinct_pvcs_without_owning_them(self):
        values = retained_values()
        resources = render_data(values)
        self.assertEqual({row["kind"] for row in resources}, {"Service", "StatefulSet"})
        stores = [row for row in resources if row["kind"] == "StatefulSet"]
        self.assertEqual({row["metadata"]["name"] for row in stores}, set(STORES))
        for store in stores:
            spec = store["spec"]
            self.assertEqual(spec["replicas"], 1)
            self.assertNotIn("volumeClaimTemplates", spec)
            pod = spec["template"]["spec"]
            self.assertEqual(pod["volumes"], [{"name": "data", "persistentVolumeClaim": {
                "claimName": values["existingClaims"][store["metadata"]["name"]],
            }}])
            self.assertFalse(pod["automountServiceAccountToken"])
            self.assertNotIn("hostNetwork", pod)
            self.assertTrue(pod["securityContext"]["runAsNonRoot"])

    def test_optional_rabbitmq_requires_its_own_restored_claim(self):
        values = retained_values()
        values["rabbitmq"]["enabled"] = True
        with self.assertRaises(subprocess.CalledProcessError):
            render_data(values)
        values["existingClaims"]["rabbitmq"] = "rabbitmq-restored"
        resources = render_data(values)
        store = next(row for row in resources if row["kind"] == "StatefulSet"
                     and row["metadata"]["name"] == "rabbitmq")
        self.assertNotIn("volumeClaimTemplates", store["spec"])
        self.assertEqual(store["spec"]["template"]["spec"]["volumes"][0]
                         ["persistentVolumeClaim"]["claimName"], "rabbitmq-restored")

    def test_invalid_or_ambiguous_restoration_cannot_start_empty_stores(self):
        base = retained_values()
        mutations = {
            "missing": lambda v: v["existingClaims"].pop("ops-mysql"),
            "unknown": lambda v: v["existingClaims"].update(other="other-restored"),
            "wrong key": lambda v: v["existingClaims"].update(
                wrong=v["existingClaims"].pop("ops-mysql")),
            "shared": lambda v: v["existingClaims"].update(redis="qdrant-restored"),
            "path": lambda v: v["existingClaims"].update(redis="../redis"),
            "invalid DNS": lambda v: v["existingClaims"].update(redis="redis..data"),
            "blank": lambda v: v["existingClaims"].update(redis=""),
            "not a map": lambda v: v.update(existingClaims=[]),
            "mixed modes": lambda v: v.update(allowDisposableData=True),
            "boolean string": lambda v: v.update(allowDisposableData="false"),
            "mutable image": lambda v: v.update(mysqlImage="mysql:8.4"),
            "local image": lambda v: v["stores"]["elasticsearch"].update(pullPolicy="Never"),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                values = copy.deepcopy(base)
                mutate(values)
                with self.assertRaises(subprocess.CalledProcessError):
                    render_data(values)

    def test_unfilled_profile_is_not_a_deployable_empty_database(self):
        values = retained_values()
        values.update(yaml.safe_load((PROFILE / "data.yaml").read_text()))
        with self.assertRaises(subprocess.CalledProcessError):
            render_data(values)


@unittest.skipUnless(shutil.which(HELM), "Install the pinned Helm CLI for render tests")
class InClusterConnectionsTests(unittest.TestCase):
    def test_service_profiles_require_verified_images_and_preserve_boundaries(self):
        for service in (*SERVICES, "web"):
            with self.subTest(service=service):
                args = ["--values", str(PROFILE / (service + ".yaml"))]
                with self.assertRaises(subprocess.CalledProcessError):
                    render(service, HELM, args)
                resources = render(service, HELM, [*args, "--set-string",
                    "image.repository=ghcr.io/fixture/" + service, "--set-string",
                    "image.digest=sha256:" + "a" * 64])
                if service != "web":
                    self.assertEqual(policy_errors(service, resources,
                        ops_sync_enabled=service == "ops-service"), [])
                deployment = next(row for row in resources if row["kind"] == "Deployment")
                pod = deployment["spec"]["template"]["spec"]
                for container in pod["containers"]:
                    self.assertEqual(container["imagePullPolicy"], "IfNotPresent")
                    env = {e["name"]: e.get("value") for e in container.get("env", [])}
                    self.assertFalse(any("host.docker.internal" in str(v) for v in env.values()))
                    if service == "ops-service":
                        self.assertIn("ops-service.govbiz-msa.svc.cluster.local",
                                      env["DJANGO_ALLOWED_HOSTS"].split(","))
                        self.assertNotIn("*", env["DJANGO_ALLOWED_HOSTS"])
                        self.assertEqual(env["CORE_API_URL"],
                            "http://core-service.govbiz-msa.svc.cluster.local:8080")
                        self.assertEqual(env["PREFECT_API_URL"],
                            "http://prefect.govbiz-evaluation.svc.cluster.local:4200/api")
                        self.assertEqual(env["LLMOPS_ARTIFACT_URL"],
                            "http://ops-artifacts.govbiz-evaluation.svc.cluster.local:8010")
                        for flag in ("LIVE", "RAG_LIVE", "SCHEDULES"):
                            self.assertEqual(env["LLMOPS_" + flag + "_ENABLED"], "false")
                    if service in {"core-service", "ai-service", "ops-service"}:
                        self.assertEqual(env["LANGFUSE_BASE_URL"],
                            "http://langfuse-web.govbiz-observability.svc.cluster.local:3000")
                        for key in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"):
                            entry = next(e for e in container["env"] if e["name"] == key)
                            self.assertEqual(entry["valueFrom"]["secretKeyRef"]["key"], key)
                            if service == "ops-service":
                                self.assertEqual(entry["valueFrom"]["secretKeyRef"]["name"], "ops-langfuse")
                            self.assertNotIn("value", entry)
                    if service == "core-service":
                        self.assertEqual(env["APP_CORS_ALLOWED_ORIGIN"], "http://localhost:18173")
                        self.assertEqual(env["CATALOG_SERVICE_URL"],
                            "http://catalog-service.govbiz-msa.svc.cluster.local:8081")
                        self.assertEqual(env["AI_SERVICE_BASE_URL"],
                            "http://ai-service.govbiz-msa.svc.cluster.local:8000")
                        self.assertEqual(env["RABBITMQ_HOST"],
                            "rabbitmq.govbiz-msa.svc.cluster.local")
                        self.assertEqual(env["RABBITMQ_PORT"], "5672")
                        for flag in ("DAILY_REPORT_QUEUE_ENABLED", "DAILY_REPORT_DELIVERY_QUEUE_ENABLED",
                                     "COMBINATION_REVIEW_QUEUE_ENABLED", "APPLICATION_FORM_DISCOVERY_QUEUE_ENABLED",
                                     "ACCOUNT_OAUTH_UNLINK_QUEUE_ENABLED", "ASSISTANT_PREFETCH_QUEUE_ENABLED"):
                            self.assertEqual(env[flag], "false")
                    if service == "web":
                        self.assertEqual(env, {})
                        self.assertEqual(container["ports"][0]["containerPort"], 8080)
                self.assertFalse(any("hostPath" in v for v in pod["volumes"]))

    def test_runner_uses_only_cluster_peers_and_remains_dormant(self):
        values = {name: {"component": name, "image": "ghcr.io/fixture/" + name + DIGEST,
                  "storage": {"existingClaim": "restored-results", "node": "fixture-node"}}
                  for name in ("prefect", "evaluation-runner", "ops-artifacts")}
        values["prefect"]["storage"]["existingClaim"] = "restored-prefect"
        values["ops-artifacts"]["evidenceImage"] = values["evaluation-runner"]["image"]
        values["evaluation-runner"].update(yaml.safe_load(
            (PROFILE / "evaluation-runner.yaml").read_text()))
        resources = render_bundle(values, helm=HELM)
        runner = next(r for r in resources["evaluation-runner"] if r["kind"] == "Deployment")
        self.assertEqual(runner["spec"]["replicas"], 0)
        pod = runner["spec"]["template"]["spec"]
        env = {e["name"]: e.get("value") for e in pod["containers"][0]["env"]}
        self.assertEqual(env["OPENAI_API_KEY"], "")
        for flag in ("LIVE", "RAG_LIVE", "SCHEDULES"):
            self.assertEqual(env["LLMOPS_" + flag + "_ENABLED"], "false")
        policy = next(r for r in resources["evaluation-runner"] if r["kind"] == "NetworkPolicy")
        self.assertFalse(any("ipBlock" in peer for rule in policy["spec"]["egress"]
                             for peer in rule["to"]))
        self.assertNotIn("hostPath", str(pod["volumes"]))


if __name__ == "__main__":
    unittest.main()
