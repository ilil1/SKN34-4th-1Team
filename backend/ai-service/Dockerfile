# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS kordoc-builder
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/chrisryugj/kordoc.git /opt/kordoc && cd /opt/kordoc && git checkout f715573df1712d415604ac949603a00e387cd3d7
WORKDIR /opt/kordoc
COPY document-tools/npm-network-retry.sh /usr/local/bin/npm-network-retry.sh
RUN --mount=type=cache,id=govbiz-kordoc-npm,target=/root/.npm,sharing=locked \
    sh /usr/local/bin/npm-network-retry.sh ci --ignore-scripts && \
    npm run build && \
    sh /usr/local/bin/npm-network-retry.sh prune --omit=dev --ignore-scripts
# The pinned upstream lock marks pdfjs-dist as dev-only; pruning removes it.
# Keep PDF parsing in a separately locked production dependency tree.
COPY document-tools/kordoc-pdf ./pdf-runtime
RUN --mount=type=cache,id=govbiz-kordoc-npm,target=/root/.npm,sharing=locked \
    sh /usr/local/bin/npm-network-retry.sh ci --prefix pdf-runtime --omit=dev --ignore-scripts && \
    ln -s ../pdf-runtime/node_modules/pdfjs-dist node_modules/pdfjs-dist && \
    node --input-type=module -e "await import('pdfjs-dist/legacy/build/pdf.mjs')"
# Remove upstream development metadata before this directory enters any runtime layer.
RUN rm -rf -- /opt/kordoc/.git /opt/kordoc/.github /opt/kordoc/tests && \
    test ! -e /opt/kordoc/.git && test ! -e /opt/kordoc/tests && \
    test -f /opt/kordoc/dist/mcp.js

FROM python:3.12-slim-bookworm AS builder

COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_DEV=1 \
    TIKTOKEN_CACHE_DIR=/app/tokenizer-cache

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY document-tools /opt/document-tools
ADD --checksum=sha256:f852e1bac18c8f435b82270fc8ff8e2ca4a2cd8869c411fa8f473f16e69585ef https://huggingface.co/jbarrow/FFDetr/resolve/56f4e4235e28dcb2953513dc020bb191a2f54cfe/FFDetr.pth /opt/document-tools/ffdetr/FFDetr.pth
RUN chmod 644 /opt/document-tools/ffdetr/FFDetr.pth
RUN uv venv /opt/document-tools/hwpx && uv pip sync --python /opt/document-tools/hwpx/bin/python /opt/document-tools/hwpx.lock && \
    uv venv /opt/document-tools/pdf && uv pip sync --python /opt/document-tools/pdf/bin/python --index-strategy unsafe-best-match /opt/document-tools/pdf.lock
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project
RUN .venv/bin/python -c "import tiktoken; tiktoken.get_encoding('cl100k_base')"

COPY app ./app
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-editable --reinstall-package govbiz-ai-service

FROM python:3.12-slim-bookworm AS runtime

ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TIKTOKEN_CACHE_DIR=/app/tokenizer-cache

ENV DOCUMENT_HWPX_COMMAND=/opt/document-tools/hwpx/bin/python \
    DOCUMENT_HWPX_ARGS='["/app/app/application_preparation/hwpx_mcp_extension.py"]' \
    DOCUMENT_PDF_COMMAND=/opt/document-tools/pdf/bin/python \
    DOCUMENT_PDF_ARGS='["/app/app/application_preparation/pdf_mcp_extension.py"]' \
    DOCUMENT_KORDOC_COMMAND=/usr/local/bin/node \
    DOCUMENT_KORDOC_ARGS='["/opt/kordoc/dist/mcp.js"]'
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /opt/document-tools /opt/document-tools
COPY --from=kordoc-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=kordoc-builder /opt/kordoc /opt/kordoc
RUN groupadd --system govbiz && \
    useradd --system \
        --gid govbiz \
        --home-dir /nonexistent \
        --shell /usr/sbin/nologin \
        govbiz

COPY --from=builder --chown=govbiz:govbiz /app/.venv /app/.venv
COPY --from=builder --chown=govbiz:govbiz /app/app /app/app
COPY --from=builder --chown=govbiz:govbiz /app/tokenizer-cache /app/tokenizer-cache

USER govbiz:govbiz

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
