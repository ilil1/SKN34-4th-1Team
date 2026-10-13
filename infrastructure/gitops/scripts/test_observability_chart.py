"""Render the deployable Langfuse stack without starting services or using live data."""

import copy
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
CHART = ROOT / "infrastructure/gitops/charts/govbiz-observability"


class ObservabilityChartTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.values = yaml.safe_load((CHART / "values.yaml").read_text())
        cls.values["node"] = "fixture-control-plane"
        cls.objects = cls.render(cls.values)

    @staticmethod
    def render(values, failure=False):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "values.yaml"
            path.write_text(yaml.safe_dump(values))
            result = subprocess.run(
                [
                    "helm",
                    "template",
                    "langfuse",
                    str(CHART),
                    "--namespace",
                    "govbiz-observability",
                    "-f",
                    str(path),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
        if failure:
            if result.returncode == 0:
                raise AssertionError("unsafe values rendered")
            return
        if result.returncode:
            raise AssertionError(result.stderr)
        return list(yaml.safe_load_all(result.stdout))

    def test_six_dormant_services_use_original_images_and_do_not_own_data_or_keys(self):
        compose = yaml.safe_load((ROOT / "infrastructure/llmops/compose.yaml").read_text())[
            "services"
        ]
        workloads = [r for r in self.objects if r["kind"] in {"Deployment", "StatefulSet"}]
        self.assertEqual(len(workloads), 6)
        self.assertEqual(sum(r["kind"] == "StatefulSet" for r in workloads), 4)
        self.assertFalse(
            any(r["kind"] in {"PersistentVolumeClaim", "Secret", "Namespace"} for r in self.objects)
        )
        for resource in workloads:
            name = resource["metadata"]["name"]
            spec = resource["spec"]["template"]["spec"]
            self.assertEqual(resource["spec"]["replicas"], 0)
            self.assertEqual(spec["containers"][0]["image"], compose[name]["image"])
            self.assertFalse(spec["automountServiceAccountToken"])
            self.assertTrue(spec["securityContext"]["runAsNonRoot"])
            self.assertNotIn("fsGroup", spec["securityContext"])
            self.assertNotIn("volumeClaimTemplates", resource["spec"])
        self.assertTrue(
            all(r["spec"]["type"] == "ClusterIP" for r in self.objects if r["kind"] == "Service")
        )

    def test_restored_data_required_and_existing_schema_and_redis_persistence_preserved(self):
        for resource in self.objects:
            if resource["kind"] not in {"Deployment", "StatefulSet"}:
                continue
            pod = resource["spec"]["template"]["spec"]
            container = pod["containers"][0]
            name = resource["metadata"]["name"]
            if resource["kind"] == "StatefulSet":
                init = pod["initContainers"][0]
                self.assertTrue(init["volumeMounts"][0]["readOnly"])
                self.assertIn(".govbiz-langfuse-restore.json", init["command"][-1])
                self.assertIn(container["image"], init["command"][-1])
                self.assertEqual(pod["volumes"][0]["persistentVolumeClaim"]["claimName"], name)
            else:
                self.assertNotIn("envFrom", container)
                self.assertEqual(pod["securityContext"]["runAsGroup"], 65533)
                env = {v["name"]: v.get("value") for v in container["env"]}
                self.assertEqual(env["LANGFUSE_AUTO_POSTGRES_MIGRATION_DISABLED"], "true")
                self.assertEqual(env["LANGFUSE_AUTO_CLICKHOUSE_MIGRATION_DISABLED"], "true")
                self.assertFalse(any(k.startswith("LANGFUSE_INIT_") for k in env))
                secrets = {
                    v["name"]: v["valueFrom"]["secretKeyRef"]
                    for v in container["env"]
                    if "valueFrom" in v
                }
                for key in ("DATABASE_URL", "SALT", "ENCRYPTION_KEY", "NEXTAUTH_SECRET"):
                    self.assertEqual(secrets[key], {"name": "langfuse-runtime", "key": key})
            if name == "redis":
                self.assertNotIn("--appendonly yes", container["command"][-1])
            if name == "clickhouse":
                self.assertIn("metadata/default.sql", init["command"][-1])
                self.assertNotIn("format_version.txt", init["command"][-1])

    def test_missing_node_mutable_images_multiple_writers_and_shared_claims_rejected(self):
        for field, value in [
            ("node", ""),
            ("images", self.values["images"] | {"postgres": "postgres:17"}),
            ("replicas", self.values["replicas"] | {"redis": 2}),
            ("claims", self.values["claims"] | {"redis": "postgres"}),
        ]:
            with self.subTest(field=field):
                self.render(self.values | {field: value}, failure=True)
        active = copy.deepcopy(self.values)
        active["replicas"] = {key: 1 for key in active["replicas"]}
        self.assertEqual(
            sum(
                r["spec"]["replicas"] == 1
                for r in self.render(active)
                if r["kind"] in {"Deployment", "StatefulSet"}
            ),
            6,
        )

    def test_evaluation_ingress_requires_namespace_and_runner_and_storage_has_no_public_route(self):
        policies = {
            r["metadata"]["name"]: r["spec"] for r in self.objects if r["kind"] == "NetworkPolicy"
        }
        self.assertEqual(policies["deny-all"]["podSelector"], {})
        peers = policies["langfuse-web-ingress"]["ingress"][0]["from"]
        self.assertIn(
            {
                "namespaceSelector": {
                    "matchLabels": {"kubernetes.io/metadata.name": "govbiz-evaluation"}
                },
                "podSelector": {"matchLabels": {"app.kubernetes.io/name": "evaluation-runner"}},
            },
            peers,
        )
        self.assertIn(
            {
                "namespaceSelector": {
                    "matchLabels": {"kubernetes.io/metadata.name": "govbiz-msa"}
                },
                "podSelector": {"matchLabels": {"app.kubernetes.io/name": "api-gateway"}},
            },
            peers,
        )
        self.assertEqual(policies["langfuse-web-ingress"]["ingress"][0]["ports"],
                         [{"protocol": "TCP", "port": 3000}])
        self.assertIn(
            {
                "namespaceSelector": {
                    "matchLabels": {"kubernetes.io/metadata.name": "govbiz-msa"}
                },
                "podSelector": {"matchExpressions": [{
                    "key": "app.kubernetes.io/name", "operator": "In",
                    "values": ["core-service", "ai-service", "ops-service"],
                }]},
            },
            peers,
        )
        self.assertTrue(all("namespaceSelector" in peer and "podSelector" in peer for peer in peers))
        for name in ("postgres", "clickhouse", "redis", "minio"):
            peer = policies[name + "-ingress"]["ingress"][0]["from"][0]
            self.assertEqual(
                peer["podSelector"]["matchExpressions"][0]["values"],
                ["langfuse-web", "langfuse-worker"],
            )
        egress = policies["langfuse-app-egress"]["egress"]
        self.assertFalse(any("ipBlock" in peer for row in egress for peer in row["to"]))


if __name__ == "__main__":
    unittest.main()
