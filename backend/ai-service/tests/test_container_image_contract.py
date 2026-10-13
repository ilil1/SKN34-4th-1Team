"""Keep upstream Git/test metadata out of every final runtime image layer."""

from pathlib import Path


def test_kordoc_metadata_is_removed_before_copying_into_runtime():
    dockerfile = (Path(__file__).resolve().parents[1] / "Dockerfile").read_text()
    kordoc_builder, rest = dockerfile.split(
        "FROM python:3.12-slim-bookworm AS builder", 1
    )
    _, runtime = rest.split("FROM python:3.12-slim-bookworm AS runtime", 1)
    assert (
        "rm -rf -- /opt/kordoc/.git /opt/kordoc/.github /opt/kordoc/tests"
        in kordoc_builder
    )
    assert "test -f /opt/kordoc/dist/mcp.js" in kordoc_builder
    assert "COPY --from=kordoc-builder /opt/kordoc /opt/kordoc" in runtime
    assert "rm -rf -- /opt/kordoc" not in runtime


def test_npm_downloads_share_cache_and_keep_build_outside_retry():
    dockerfile = (Path(__file__).resolve().parents[1] / "Dockerfile").read_text()
    builder = dockerfile.split("FROM python:3.12-slim-bookworm AS builder", 1)[0]
    assert (
        "COPY document-tools/npm-network-retry.sh /usr/local/bin/npm-network-retry.sh"
        in builder
    )
    assert (
        builder.count(
            "type=cache,id=govbiz-kordoc-npm,target=/root/.npm,sharing=locked"
        )
        == 2
    )
    assert "sh /usr/local/bin/npm-network-retry.sh ci --ignore-scripts" in builder
    assert "sh /usr/local/bin/npm-network-retry.sh ci --prefix pdf-runtime" in builder
    assert (
        "sh /usr/local/bin/npm-network-retry.sh prune --omit=dev --ignore-scripts"
        in builder
    )
    assert "npm run build" in builder
    assert "npm-network-retry.sh run build" not in builder
