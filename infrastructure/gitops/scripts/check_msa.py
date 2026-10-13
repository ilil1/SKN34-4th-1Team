"""Offline Helm/Argo policy checks. Not a cluster or GitOps sync test."""

import argparse
import copy
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit

import yaml

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = ROOT.parents[1]
REPOSITORY_URL = "https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team.git"
REPOSITORY_BRANCH = "main"
CHART_PATH = "infrastructure/gitops/charts/govbiz-service"
SERVICES = ("core-service", "catalog-service", "ai-service", "ops-service")
NAMESPACE = "govbiz-msa"


def render(service, helm="helm", extra=()):
    result = subprocess.run(
        [helm, "template", service, str(ROOT / "charts/govbiz-service"),
         "--namespace", NAMESPACE, "--values", str(ROOT / f"environments/local-msa/{service}.yaml"),
         *extra], check=True, capture_output=True, text=True, timeout=30,
    )
    return list(yaml.safe_load_all(result.stdout))


def policy_errors(service, resources, *, require_ops_migration=True, ops_sync_enabled=None,
                  autoscaling=None):
    errors = []

    def require(condition, message):
        if not condition:
            errors.append(f"{service}: {message}")

    jobs = [r for r in resources if r["kind"] == "Job"]
    resources = [r for r in resources if r["kind"] != "Job"]
    autoscaling = autoscaling or {}
    scaled = autoscaling.get("enabled") is True
    hpas = [r for r in resources if r["kind"] == "HorizontalPodAutoscaler"]
    resources = [r for r in resources if r["kind"] != "HorizontalPodAutoscaler"]
    require(len(hpas) == (1 if scaled else 0), "HPA must match explicit autoscaling opt-in")
    require(not jobs or service == "ops-service", "only Ops may own a migration Job")
    require(len(jobs) == (1 if service == "ops-service" and require_ops_migration else 0),
            "expected one required Ops migration Job and no other Jobs")
    by_kind = {r["kind"]: r for r in resources}
    require(len(resources) == 2 and set(by_kind) == {"Deployment", "Service"},
            "one service release must own only Deployment and Service")
    if set(by_kind) != {"Deployment", "Service"}:
        return errors
    for item in resources + hpas:
        require(item["metadata"]["name"] == service, "wrong resource name")
        require(item["metadata"]["namespace"] == NAMESPACE, "wrong namespace")
    spec = by_kind["Deployment"]["spec"]
    pod = spec["template"]["spec"]
    if scaled:
        require(service in {"core-service", "ai-service", "web"},
                "only reviewed HTTP services may autoscale")
        require("replicas" not in spec and spec["strategy"] == {
            "type": "RollingUpdate", "rollingUpdate": {"maxSurge": 1, "maxUnavailable": 0}},
            "HPA must own replicas and rolling updates must retain ready capacity")
        require(pod.get("topologySpreadConstraints") == [{
            "maxSkew": 1, "topologyKey": "kubernetes.io/hostname",
            "whenUnsatisfiable": "ScheduleAnyway",
            "labelSelector": {"matchLabels": spec["selector"]["matchLabels"]},
        }], "autoscaled HTTP Pods must prefer spreading without blocking single-node use")
        lower, upper = autoscaling.get("minReplicas", 1), autoscaling.get("maxReplicas", 3)
        target = autoscaling.get("targetCPUUtilizationPercentage", 70)
        require(all(type(value) is int for value in (lower, upper, target))
                and 1 <= lower <= upper <= 10 and 1 <= target <= 100,
                "autoscaling bounds and CPU target must be valid")
        if hpas:
            require(hpas[0].get("apiVersion") == "autoscaling/v2" and hpas[0]["spec"] == {
                "scaleTargetRef": {"apiVersion": "apps/v1", "kind": "Deployment", "name": service},
                "minReplicas": lower, "maxReplicas": upper,
                "metrics": [{"type": "ContainerResource", "containerResource": {
                    "name": "cpu", "container": service,
                    "target": {"type": "Utilization", "averageUtilization": target},
                }}],
                "behavior": {
                    "scaleUp": {"stabilizationWindowSeconds": 0,
                                "policies": [{"type": "Pods", "value": 2, "periodSeconds": 60}]},
                    "scaleDown": {"stabilizationWindowSeconds": 300,
                                  "policies": [{"type": "Pods", "value": 1, "periodSeconds": 60}]},
                },
            }, "HPA target, bounds, metric or scaling behavior differs from reviewed settings")
    else:
        require(spec.get("replicas") == 1 and spec["strategy"] == {"type": "Recreate"},
                "single writer must not overlap during rollout")
    require(pod["automountServiceAccountToken"] is False, "API token must not be mounted")
    require(pod["securityContext"]["runAsNonRoot"] is True, "non-root required")
    require(not any(k in pod for k in ("hostNetwork", "hostPID", "hostIPC")), "host isolation required")
    require(not any("hostPath" in v for v in pod["volumes"]), "no host data mounts")
    container = pod["containers"][0]
    if scaled:
        cpu = str(container.get("resources", {}).get("requests", {}).get("cpu", ""))
        require(bool(re.fullmatch(r"([0-9]+([.][0-9]+)?|[.][0-9]+)m?", cpu))
                and float(cpu.removesuffix("m")) > 0,
                "HPA requires a positive CPU request for its target container")
    containers = pod["containers"]
    sync_enabled = len(containers) == 2 and service == "ops-service"
    if ops_sync_enabled is not None:
        require(type(ops_sync_enabled) is bool and sync_enabled == ops_sync_enabled,
                "Ops sync container does not match the selected values")
    require(container["name"] == service and (len(containers) == 1 or sync_enabled), "wrong container")
    if sync_enabled:
        expected_sync = copy.deepcopy(container)
        for name in ("ports", "startupProbe", "readinessProbe", "livenessProbe"):
            expected_sync.pop(name, None)
        expected_sync.update(name="ops-sync", command=["python", "manage.py", "sync_evaluations", "--watch"])
        require(containers[1] == expected_sync,
                "Ops sync must use the API image, environment, secrets and security without HTTP probes")
        sync_env = {item["name"]: item.get("value", "") for item in container["env"]}
        for name in ("PREFECT_API_URL", "LLMOPS_ARTIFACT_URL"):
            try:
                url = urlsplit(sync_env.get(name, ""))
                valid = (url.scheme in {"http", "https"} and bool(url.hostname)
                         and not (url.username or url.password or url.query or url.fragment)
                         and not url.hostname.endswith(".invalid")
                         and url.hostname not in {"localhost", "::1"}
                         and not url.hostname.startswith("127.")
                         and not any(char.isspace() or char == "\\" for char in url.geturl()))
                _ = url.port
            except ValueError:
                valid = False
            require(valid, "Ops sync requires a configured remote " + name)
        token = next((item for item in container["env"] if item["name"] == "LLMOPS_ARTIFACT_TOKEN"), {})
        require(token.get("valueFrom") == {"secretKeyRef": {"name": "ops-runtime", "key": "LLMOPS_ARTIFACT_TOKEN"}}
                and "value" not in token, "Ops sync requires an ops-runtime artifact token reference")
    require(container["securityContext"]["readOnlyRootFilesystem"] is True, "read-only image required")
    require(not container["securityContext"]["allowPrivilegeEscalation"], "privilege escalation forbidden")
    require(not container["image"].endswith(":latest"), "mutable latest tag forbidden")
    for probe in ("startupProbe", "readinessProbe", "livenessProbe"):
        require(bool(container.get(probe)), f"missing {probe}")
    for budget in ("requests", "limits"):
        require(set(container["resources"][budget]) >= {"cpu", "memory"}, f"missing {budget}")
    entries = container["env"]
    env = {e["name"]: e.get("value") for e in entries}
    require(len(env) == len(entries), "duplicate environment keys forbidden")
    runtime_secret = service.removesuffix("-service") + "-runtime"
    trace_keys = {"LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"}
    ops_traces = service == "ops-service" and bool(trace_keys & set(env))
    if ops_traces:
        require(trace_keys <= set(env), "Ops traces require both dedicated credentials")
    secret_names = set()
    for entry in entries:
        expected_secret = "ops-langfuse" if ops_traces and entry["name"] in trace_keys else runtime_secret
        if "valueFrom" in entry:
            reference = entry["valueFrom"].get("secretKeyRef", {})
            secret_names.add(reference.get("name"))
            require(entry["valueFrom"] == {"secretKeyRef": {
                "name": expected_secret, "key": entry["name"]}} and "value" not in entry,
                "service-scoped secret required")
        elif ops_traces and entry["name"] in trace_keys:
            require(False, "Ops traces require dedicated Secret references")
    expected_secrets = {runtime_secret} | ({"ops-langfuse"} if ops_traces else set())
    require(secret_names == expected_secrets, "service-scoped secret required")
    if service == "core-service":
        require(env.get("CATALOG_PROJECTION_ENABLED") == "true", "Core must use Catalog")
        require(env.get("CATALOG_SERVICE_URL") in {
            "http://catalog-service:8081",
            "http://catalog-service.govbiz-msa.svc.cluster.local:8081",
        }, "wrong Catalog endpoint")
        for source in ("BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE"):
            require(env.get(source + "_SYNC_ENABLED") == "false", "Core source writer enabled")
        require(env.get("SUPPORT_PROGRAM_INDEX_ENABLED") == "false", "Core index writer enabled")
        require("catalog-mysql" not in str(env), "Core must not access Catalog DB")
    if service == "catalog-service":
        require("core-mysql" not in str(env), "Catalog must not access Core DB")
    if service == "ai-service":
        require(not any("DATASOURCE" in key or key.startswith("DB_") for key in env), "AI must not get SQL credentials")
    if jobs and service == "ops-service":
        expected_pod = copy.deepcopy(pod)
        expected_pod["restartPolicy"] = "Never"
        expected_pod["containers"] = [copy.deepcopy(container)]
        migration = expected_pod["containers"][0]
        for name in ("ports", "startupProbe", "readinessProbe", "livenessProbe"):
            migration.pop(name, None)
        migration.update(name="ops-migrate", command=["python", "manage.py", "migrate_deployment"])
        expected = {"backoffLimit": 0, "activeDeadlineSeconds": 300,
                    "template": {"metadata": {"labels": {"app.kubernetes.io/name": "ops-service-migrate"}},
                                 "spec": expected_pod}}
        job = jobs[0]
        require(job.get("apiVersion") == "batch/v1" and job.get("spec") == expected,
                "migration must use the same image, configuration and security with no automatic retry")
        require(job.get("metadata") == {"name": "ops-service-migrate", "namespace": NAMESPACE,
                "annotations": {"argocd.argoproj.io/hook": "PreSync",
                "argocd.argoproj.io/hook-delete-policy": "BeforeHookCreation,HookSucceeded"}},
                "migration must be a bounded PreSync hook retaining failed Jobs")
    network = by_kind["Service"]["spec"]
    require(network["type"] == "ClusterIP", "internal service required")
    require(network["selector"] == spec["template"]["metadata"]["labels"], "Service must select its own pods")
    return errors


def argo_errors(root=ROOT):
    project = yaml.safe_load((root / "argocd/local/project.yaml").read_text())["spec"]
    apps = list(yaml.safe_load_all((root / "argocd/local/applications.yaml").read_text()))
    errors = []
    if project["sourceRepos"] != [REPOSITORY_URL]:
        errors.append("Argo source repository scope widened")
    expected_destination = {"server": "https://kubernetes.default.svc", "namespace": NAMESPACE}
    if project["destinations"] != [expected_destination] or project["clusterResourceWhitelist"]:
        errors.append("Argo destination/cluster permission scope widened")
    if project["namespaceResourceWhitelist"] != [{"group": "apps", "kind": "Deployment"}, {"group": "", "kind": "Service"}, {"group": "batch", "kind": "Job"}]:
        errors.append("Argo resource scope widened")
    if {app["metadata"]["name"] for app in apps} != {"govbiz-" + s for s in SERVICES} or len(apps) != 4:
        errors.append("Expected four independent Argo Applications")
    for app in apps:
        service = app["metadata"]["name"].removeprefix("govbiz-")
        spec = app["spec"]
        source = spec["source"]
        if spec["project"] != "govbiz-local-msa" or spec["destination"] != expected_destination:
            errors.append("Application escaped local project")
        if source["repoURL"] != project["sourceRepos"][0] or source["path"] != CHART_PATH or source["targetRevision"] != REPOSITORY_BRANCH:
            errors.append("Application source mismatch")
        if source["helm"] != {"releaseName": service, "valueFiles": [f"../../environments/local-msa/{service}.yaml"]}:
            errors.append("Application must render exactly one service values file")
        if spec.get("syncPolicy") != {"syncOptions": ["FailOnSharedResource=true"]}:
            errors.append("Initial sync must be manual without prune or self-heal")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helm", default="helm")
    args = parser.parse_args()
    errors = argo_errors()
    for service in SERVICES:
        errors.extend(policy_errors(service, render(service, args.helm)))
    if errors:
        raise SystemExit("\n".join(errors))
    print("PASS: four isolated Helm releases, data/writer ownership and restricted Argo definitions")
    print("Not a runtime, NetworkPolicy enforcement, authentication or GitOps sync proof.")


if __name__ == "__main__":
    main()
