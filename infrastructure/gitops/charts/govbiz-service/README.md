# GovBiz HTTP service chart

기본값은 기존 단일 Pod·`Recreate` 배포를 유지합니다. 여러 Pod에서 실행해도 중복 작업이나
로컬 상태 유실이 없는지 확인한 Core·AI·웹 서비스만 다음 설정으로 자동 확장을 켭니다.
Catalog 수집기와 Ops sync는 이 옵션의 대상이 아닙니다.

```yaml
autoscaling:
  enabled: true
  minReplicas: 1
  maxReplicas: 3
  targetCPUUtilizationPercentage: 70
```

활성화하면 Deployment의 `replicas`를 생략해 HPA가 수를 관리하고, 준비된 Pod를 유지하는
`RollingUpdate`와 노드 간 분산 선호 설정을 적용합니다. 단일 노드에서도 배치는 가능합니다.
축소·교체 시 Pod 종료 유예는 300초이며, 처음 10초는 Kubernetes의 `preStop.sleep`으로
엔드포인트 제외가 전파되기를 기다립니다. 서버의 graceful shutdown 설정도 함께 맞춰야 합니다.
`autoscaling/v2` HPA는 해당 서비스 컨테이너의 CPU 사용량을 `resources.requests.cpu`에
대한 비율로 측정합니다. 요청량은 양수여야 하며, 복제 수는 `1 ≤ min ≤ max ≤ 10`, 목표 CPU는
`1..100` 범위로 제한합니다. 축소는 5분 안정화 후 분당 한 Pod씩 진행합니다.

Metrics Server, 노드 자동 확장기, 노드 그룹 최대 크기는 클러스터에서 별도로 구성해야 합니다.
CPU 기반 HPA만으로 외부 API·DB 대기나 모든 트래픽 급증을 감지하지는 못합니다.
Argo CD는 활성화된 Deployment의 `/spec/replicas` 차이를 무시하고
`RespectIgnoreDifferences=true`를 사용해야 기존 HPA 결정이 동기화로 덮어써지지 않습니다.

Ops 관리자 실행 추적 조회는 `opsTraces.enabled: true`로 켭니다. 기본값은 `false`이며
`ops-service`에만 적용할 수 있습니다. 기존 프로젝트의 `LANGFUSE_PUBLIC_KEY`,
`LANGFUSE_SECRET_KEY`를 같은 namespace의 전용 `ops-langfuse` Secret에 준비합니다.
API·sync·migration은 이 두 키만 참조합니다. `env`나 `secretKeys`에 같은 키를 중복 등록하면
렌더링을 거절합니다. 기존 `ops-runtime`과 암호화 백업 범위는 변경하지 않습니다.
