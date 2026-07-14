# Moira — GPU 클러스터 용량 시뮬레이터

노드 풀과 워크로드 목록을 입력하면, kube-scheduler를 단순화한 bin-packing 시뮬레이션으로
배치 결과를 계산하고 MIG 파티셔닝을 포함한 GPU 점유 상태를 시각화하는 도구입니다.

핵심 가치는 **배치 실패 시 어떤 자원/제약이 병목인지 구분해서 보여주는 것**입니다 —
단순히 "실패"가 아니라 GPU 부족인지, vCPU 병목인지, MIG 파티셔닝으로 GPU가 잠긴 것인지를
사람이 읽을 수 있는 문장으로 알려줍니다.

백엔드 없이 모든 시뮬레이션은 브라우저에서 순수 함수로 실행됩니다.

## 실행

```bash
npm install
npm run dev      # 개발 서버 (http://localhost:5173)
npm test         # vitest — 시뮬레이션 로직 테스트 18개
npm run build    # 타입체크 + 프로덕션 빌드
```

## 화면 구성

**좌측 — 입력 패널**
- 노드 풀 테이블: GPU 모델(H100-80GB / A100-40GB / L40S-48GB), GPU 수, vCPU, 메모리,
  동일 스펙 노드 수, MIG 모드(disabled / static / dynamic)
- static 모드 레이아웃 빌더: 프로파일을 추가하면 slice 게이지가 7까지 차오르고, 초과하는
  프로파일은 추가 버튼이 비활성화됩니다
- 워크로드 테이블: Full GPU / MIG 프로파일 요청 토글, vCPU·메모리·replicas, 모델 제약
- 배치 전략 토글(binpack / spread)과 프리셋 3종
- 모든 입력은 localStorage에 자동 저장/복원됩니다

**중앙 — GPU 히트맵** (CSS Grid, 차트 라이브러리 없음)
- 노드 1개 = 카드 1개, GPU 1개 = 가로 7칸 슬라이스 바
- whole 할당은 7칸 전체가 워크로드 색, MIG 인스턴스는 slice 폭만큼 블록
  (할당 = 워크로드 색, 미할당 인스턴스 = 점선 테두리, 커빙되지 않은 잔여 slice = 회색)
- static으로 사전 파티셔닝된 GPU에는 🔒 표시, 호버 시 워크로드/프로파일 툴팁
- 카드 하단에 vCPU/메모리 점유율 미터

**우측 — 결과 요약**
- 배치 성공률, slice 단위 GPU 활용률, 노드 평균 점유율
- 배치 실패 목록: 워크로드별 실패 사유를 문장으로 표시
- 프래그멘테이션 리포트: 미할당 slice 분해(유휴 whole GPU / 미할당 인스턴스 / 잔여 slice),
  현재 상태에서 수용 불가능한 최소 프로파일

## 시뮬레이션 모델

전체 로직은 [src/simulate.ts](src/simulate.ts)에 순수 함수로 격리되어 있습니다.

```ts
simulate(nodes: NodeSpec[], workloads: WorkloadSpec[], { strategy: "binpack" | "spread" })
  => { placements, gpuStates, nodeStates }
```

**전처리**
1. 노드 풀을 `count`만큼 개별 노드로 전개
2. `migMode: "static"` 노드는 `staticLayout`대로 모든 GPU를 미리 파티셔닝
   (파티셔닝된 GPU는 whole 할당 불가)
3. 워크로드 정렬: full 요청(GPU count 내림차순) → MIG 요청(프로파일 slices 내림차순).
   full을 먼저 배치해야 dynamic 노드의 온전한 GPU가 MIG 커빙으로 소모되는 것을 막습니다

**파드별 배치**
- Full 요청: 미할당 whole GPU가 count개 이상 + vCPU/메모리 잔량 + 모델 제약을 통과한
  노드 중 전략 점수(binpack = 점유율 높은 노드, spread = 낮은 노드)로 선택
- MIG 요청: ① 해당 프로파일의 미할당 인스턴스가 충분한 노드 재사용(커빙보다 우선) →
  ② 없으면 dynamic 노드의 미사용 whole GPU 하나를 homogeneous 정책으로 커빙
  (예: 1g 요청 → 1g×7, 2g 요청 → 2g×3 + 잔여 1 slice)
- vCPU/메모리는 MIG 여부와 무관하게 노드 단위 총량에서 차감

**실패 사유(failReason) 구분**

| 사유 | 의미 |
|---|---|
| `gpu` | 어떤 노드에도 요청 수만큼의 온전한 GPU가 없음 |
| `mig-mode-mismatch` | GPU 수는 충분하지만 MIG 파티셔닝으로 잠겨 whole 할당 불가 |
| `vcpu` / `memory` | GPU는 확보 가능하지만 vCPU/메모리 잔량 부족 |
| `model` | 모델 제약 불일치, 또는 MIG 미지원 모델(L40S)에 MIG 요청 |
| `mig-no-instance` | 미할당 인스턴스 없음 (static 노드는 새로 커빙하지 않음) |
| `mig-cannot-carve` | dynamic 노드에 커빙할 미사용 whole GPU가 없음 |

**결정성 규칙(스펙 외 구현 선택)**
- 전략 점수 동점이면 노드 전개 순서상 앞 노드를 선택 — 같은 입력은 항상 같은 결과
- vCPU/메모리 부족이 혼재하면 노드별 첫 부족 자원 기준, 전부 메모리 부족일 때만 `memory`
- `mig-mode-mismatch`는 "파티셔닝됐지만 인스턴스가 전부 미할당인 GPU"를 whole로
  되돌린다고 가정했을 때 요청이 충족되는 경우에만 보고

**레이아웃 검증**: `isValidLayout(gpuModel, profiles)`([src/catalog.ts](src/catalog.ts))로
격리되어 있습니다. v1은 "Σ slices ≤ 7" 합산 모델만 검사하며, NVIDIA 허용 조합 테이블로
교체하려면 이 함수만 바꾸면 됩니다.

## 프로젝트 구조

```
src/
  types.ts            데이터 모델 (노드/워크로드/배치 결과)
  catalog.ts          GPU 카탈로그 시드 + isValidLayout
  simulate.ts         배치 시뮬레이션 (순수 함수)
  simulate.test.ts    vitest 테스트 18개
  presets.ts          프리셋 시나리오 3종
  App.tsx             상태 관리 + localStorage
  ui/
    InputPanel.tsx    노드 풀/워크로드/전략 입력
    Heatmap.tsx       GPU 슬라이스 히트맵
    SummaryPanel.tsx  결과 요약 + 프래그멘테이션 리포트
    colors.ts         워크로드 색상 슬롯 배정 (id 고정, 순환 없음)
```

## 한계 (v1)

- MIG 레이아웃 검증이 slice 합산 근사입니다 — 실제 NVIDIA 허용 조합/배치 위치 제약은
  반영되지 않습니다
- 커빙은 파드당 GPU 1개까지만 시도합니다 (여러 GPU에 걸친 단일 파드 MIG 커빙 없음)
- 스케줄러 점수는 GPU slice 점유율만 반영합니다 (vCPU/메모리는 필터로만 사용)
