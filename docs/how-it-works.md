# Moira 동작 원리 (How It Works)

MIG를 지원하는 GPU 클러스터 용량 시뮬레이터의 핵심 동작을 설명한다.
자원 모델 → 전체 파이프라인 → MIG 배치 결정 흐름 순서로 읽으면 된다.

> 모든 시뮬레이션은 브라우저에서 순수 함수 `simulate()`로 실행되며,
> 입력한 클러스터 정보는 서버로 전송되지 않고 사용자 브라우저(localStorage)에만 저장된다.

---

## 1. 자원 모델 — GPU = compute slice 7칸

이 시뮬레이터의 기반 멘털 모델이다. GPU 1개를 compute slice 7칸짜리 막대로 보고,
워크로드가 이 칸을 어떻게 점유하는지가 시뮬레이션의 전부다.
MIG 프로파일 `Ng.XXgb`는 slice N개를 소비하며, 제약은 `Σ slices ≤ 7` 하나로 단순화한다
(slice 합산 모델 — NVIDIA 허용 조합 테이블로의 교체는 `isValidLayout()` 함수 하나로 격리되어 있다).

![GPU slice 모델](assets/gpu-slice-model.svg)

| 상태 | 의미 |
|---|---|
| whole 할당 | full GPU 요청(`nvidia.com/gpu: N`)이 GPU 전체를 점유 |
| 파티셔닝됨 | MIG 인스턴스로 분할됨. 색칠 블록 = 할당, 점선 블록 = 빈 인스턴스 |
| 미사용 (dynamic) | 아직 커빙되지 않은 온전한 GPU. full 할당과 커빙 모두 가능 |

**핵심 규칙: whole 할당과 파티셔닝은 GPU 단위로 배타적이다.**
한 번 파티셔닝된 GPU는 full GPU 요청을 받을 수 없다 — 이것이 `mig-mode-mismatch` 실패의 원인이며,
"GPU 수는 충분한데 배치가 안 되는" 상황을 설명해 준다.

---

## 2. 전체 파이프라인

입력이 결과가 되기까지의 흐름. 배치가 **두 단계로 나뉘는 것**이 이 설계의 포인트다.

![시뮬레이터 전체 파이프라인](assets/simulate-pipeline.svg)

### 전처리

1. 노드 풀을 `count`만큼 개별 노드로 전개하고 GPU 상태 배열을 초기화한다.
2. `migMode=static` 노드는 `staticLayout`대로 GPU를 미리 파티셔닝한다. 이 GPU들은 whole 할당 불가로 잠긴다.
3. 워크로드를 정렬한다: **full 요청(count 내림차순) 먼저, MIG 요청(프로파일 slices 내림차순) 나중.**

### 왜 full 요청을 먼저 배치하는가

순서를 바꾸면 dynamic 노드의 온전한 GPU가 MIG 커빙으로 먼저 잘려나가서,
나중에 온 full 요청이 GPU 총량은 충분한데도 실패한다.
이 정렬 하나가 시뮬레이션 결과의 신뢰도를 좌우한다.

---

## 3. MIG 요청 배치 결정 흐름

2단계 안에서 MIG 요청 하나(profile × N)가 배치될 때의 결정 흐름.
실패 원인 코드(`failReason`)가 어디서 나오는지가 여기서 결정된다.

![MIG 요청 배치 결정 흐름](assets/mig-placement-flow.svg)

우선순위는 **재사용 우선, 커빙은 차선**이다. 이미 파티셔닝된 GPU의 빈 인스턴스를 먼저 소진해야
온전한 GPU를 아껴서 이후의 full 요청·다른 프로파일 커빙에 대비할 수 있다.

- **커빙 정책 (homogeneous):** 새 GPU를 커빙할 때는 요청 프로파일로 slice 7까지 꽉 채운다
  (예: `1g.10gb` 요청 → `1g × 7`). 단순하고 예측 가능하다.
- **static 노드는 커빙하지 않는다.** `staticLayout`에 정의된 인스턴스만 사용한다.
  실제 운영에서 GPU Operator의 `mig.config` 라벨로 노드 프로파일을 고정해 둔 상황에 대응한다.
- vCPU/메모리는 MIG 여부와 무관하게 **노드 단위 총량**에서 차감한다.

---

## 4. 실패 원인 코드 (failReason)

배치 실패를 원인별로 구분해 기록하는 것이 이 도구의 핵심 가치다.
"GPU는 남는데 왜 안 들어가는가"에 답할 수 있어야 한다.

| 코드 | 의미 | 운영자가 취할 조치 |
|---|---|---|
| `gpu` / `vcpu` / `memory` | 해당 자원 잔량 부족 | 병목 자원 증설 또는 요청 조정 |
| `model` | `gpuModelConstraint` 불일치 | 제약 완화 또는 해당 모델 노드 추가 |
| `mig-mode-mismatch` | full 요청인데 GPU가 파티셔닝으로 잠김 | MIG 레이아웃 축소 검토 |
| `mig-no-instance` | 맞는 프로파일의 빈 인스턴스 없음 (static) | **레이아웃을 바꿔야 한다는 신호** |
| `mig-cannot-carve` | dynamic이지만 커빙할 whole GPU 없음 | **GPU 자체가 부족하다는 신호** |

`mig-no-instance`와 `mig-cannot-carve`를 구분하는 것은 의도된 설계다.
전자는 파티션 구성의 문제, 후자는 총량의 문제라 운영자가 취할 조치가 다르기 때문이다.

---

## 5. static vs dynamic 모드의 의미

| 모드 | 대응하는 운영 시나리오 | 시뮬레이션에서의 용도 |
|---|---|---|
| `disabled` | MIG 미사용 노드 | 기본 bin-packing |
| `static` | GPU Operator로 레이아웃 고정 | **현재 구성의 실제 수용량** 파악 |
| `dynamic` | 필요 시 재파티셔닝 가능하다고 가정 | **재구성 시 도달 가능한 상한선** 파악 |

같은 입력으로 두 모드를 비교하면 "지금 고정 레이아웃으로는 70%인데,
재구성하면 91%까지 가능" 같은 인사이트를 얻을 수 있다 — 이것이 이 시뮬레이터의 핵심 사용 사례다.
