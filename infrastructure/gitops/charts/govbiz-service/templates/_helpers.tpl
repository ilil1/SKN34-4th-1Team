{{- define "govbiz.image" -}}
{{- $repository := required "image.repository is required" .Values.image.repository -}}
{{- $image := "" -}}
{{- if .Values.image.digest -}}
  {{- if not (regexMatch "^sha256:[a-f0-9]{64}$" .Values.image.digest) -}}
    {{- fail "image.digest must be a sha256 digest" -}}
  {{- end -}}
  {{- $image = printf "%s@%s" $repository .Values.image.digest -}}
{{- else if and .Values.localMode .Values.image.tag (ne .Values.image.tag "latest") -}}
  {{- $image = printf "%s:%s" $repository .Values.image.tag -}}
{{- else -}}
  {{- fail "A digest is required outside localMode; local tags must not be latest" -}}
{{- end -}}
{{- $image -}}
{{- end -}}

{{- define "govbiz.opsTraceCredentials" -}}
{{- if .Values.opsTraces.enabled -}}
{{- range $key := list "LANGFUSE_PUBLIC_KEY" "LANGFUSE_SECRET_KEY" }}
- name: {{ $key }}
  valueFrom:
    secretKeyRef:
      name: ops-langfuse
      key: {{ $key }}
{{- end -}}
{{- end -}}
{{- end -}}
