# kSQL-Flow Execution Contract v1

- 状態: **PROPOSED**
- contract ID: `ksql-flow.execution/v1`
- 作成日: 2026-08-29
- 対象: kSQL-FlowNetから`ksql-flow`のrun・検査コマンドを呼び出すCLI境界

---

## 1. 目的

Control PlaneがkSQL-Flowの内部型、例外、module構造へ依存せず、単一ジョブを起動して結果を一意に解釈できるversion付き契約を定義する。

本契約は次を対象とする。

- 入力引数
- structured execution result
- Exit Code
- stdout／stderr
- signal／強制終了
- correlation ID
- version／capability negotiation
- Job lock recovery／force-unlock
- errorと秘密情報の扱い

`run-all`のバッチ集約結果とdry-runの既存JSONは本契約の対象外とする。

---

## 2. CLI

提案する呼出形式:

```bash
ksql-flow run \
  -f <snapshot-sql-path> \
  --profile <profile> \
  --config <config-path> \
  --as-of <ISO-8601> \
  --result-json - \
  --correlation-id <network-run-id> \
  --attempt-id <node-attempt-id> \
  --expected-job-id <job-id>
```

### 追加オプション

| オプション | 必須 | 意味 |
| --- | --- | --- |
| `--result-json <path|->` | orchestrator経由では必須 | `-`はstdout、pathは指定ファイルへ結果JSONを出力 |
| `--correlation-id <id>` | 必須 | Network Run等の親相関ID。実行意味論には使用しない |
| `--attempt-id <id>` | 必須 | Control PlaneのNode Attempt ID |
| `--expected-job-id <id>` | 必須 | DAG nodeの`job_id`。SQLから解決した論理job IDとの一致を実行前に検証 |

既存`--json`はdry-run専用のため、通常runの結果には流用しない。

### 入力検証

- `--result-json -`ではstdoutへJSON以外を出力しない。
- correlation IDとattempt IDは1〜128文字のASCII安全文字に制限する。
- IDをロックキーの生成材料にしない。
- `expected-job-id`はSQLの論理job IDと完全一致しなければならず、Nodeロックキーは一致確認後の論理job IDから生成する。
- SQL pathは存在する通常ファイルでなければならない。
- orchestratorはbundle展開先からの絶対pathを渡す。
- symlink、path traversal、bundle外参照の可否はorchestratorの展開規則で固定する。
- `--as-of`はsnapshot値と一致しなければならない。

---

## 3. Execution Result

### 3.1 正常終了例

```json
{
  "formatVersion": 1,
  "kind": "EXECUTION_RESULT",
  "contract": "ksql-flow.execution/v1",
  "correlationId": "netrun_20260829_001",
  "attemptId": "attempt_20260829_001_A_001",
  "executionId": "ksqlrun_20260829_001",
  "jobId": "aggregate_customer",
  "profile": "prod",
  "status": "SUCCESS",
  "resultCode": "OK",
  "executionStarted": true,
  "exitCode": 0,
  "asOf": "2026-08-01T00:00:00+09:00",
  "startedAt": "2026-08-29T08:00:00.000Z",
  "finishedAt": "2026-08-29T08:02:00.000Z",
  "durationMs": 120000,
  "readCount": 30000,
  "writtenCount": 30000,
  "deletedCount": 0,
  "apiCalls": 650,
  "lastSuccessfulChunkNo": 300,
  "lastWrittenKey": "C030000",
  "ksqlFlowVersion": "0.x.y",
  "engineVersion": "3.x.y",
  "error": null
}
```

`lastSuccessfulChunkNo`と`lastWrittenKey`は診断情報であり、途中再開カーソルではない。

### 3.2 失敗例

```json
{
  "formatVersion": 1,
  "kind": "EXECUTION_RESULT",
  "contract": "ksql-flow.execution/v1",
  "correlationId": "netrun_20260829_001",
  "attemptId": "attempt_20260829_001_A_001",
  "executionId": "ksqlrun_20260829_001",
  "jobId": "aggregate_customer",
  "profile": "prod",
  "status": "FAILED",
  "resultCode": "API_ERROR",
  "executionStarted": true,
  "exitCode": 3,
  "asOf": "2026-08-01T00:00:00+09:00",
  "startedAt": "2026-08-29T08:00:00.000Z",
  "finishedAt": "2026-08-29T08:01:10.000Z",
  "durationMs": 70000,
  "readCount": 30000,
  "writtenCount": 12000,
  "deletedCount": 0,
  "apiCalls": 420,
  "lastSuccessfulChunkNo": 120,
  "lastWrittenKey": "C012000",
  "ksqlFlowVersion": "0.x.y",
  "engineVersion": "3.x.y",
  "error": {
    "category": "API",
    "code": "KINTONE_ERROR",
    "message": "kintone API request failed",
    "retryable": false,
    "detailsTruncated": true
  }
}
```

### 3.3 必須フィールド

| フィールド | 型 | 規則 |
| --- | --- | --- |
| `formatVersion` | number | literal `1` |
| `kind` | string | literal `EXECUTION_RESULT` |
| `contract` | string | literal `ksql-flow.execution/v1` |
| `correlationId` | string | 入力値と一致 |
| `attemptId` | string | 入力値と一致 |
| `executionId` | string | kSQL-Flowが発行する一意ID |
| `jobId` | string | SQL header等から解決した論理ジョブID |
| `profile` | string | 解決済みprofile名 |
| `status` | string | `SUCCESS` / `FAILED` / `CANCELLED` |
| `resultCode` | string | 本書4章の安定コード |
| `executionStarted` | boolean | SQLの最初の文を開始したか。有効な最終結果内の要約であり、単独では耐久証跡ではない |
| `exitCode` | number | 実プロセス終了コードと一致 |
| `asOf` | string/null | 使用したas-of |
| `startedAt` | string/null | UTC ISO 8601。実行未開始ならnull |
| `finishedAt` | string | UTC ISO 8601 |
| `durationMs` | number | 0以上 |
| count類 | number | 0以上の整数 |
| version類 | string | 実行時version |
| `error` | object/null | 成功時null |

未知フィールドは無視する。v1内のフィールド追加はadditiveとする。既存フィールドの削除、型変更、意味変更は新しいcontract versionを必要とする。

---

## 4. StatusとresultCode

### 4.1 status

| status | 意味 |
| --- | --- |
| `SUCCESS` | 業務実行が正常完了。NO_DATAを含む |
| `FAILED` | 検証、ASSERT、API、SQL、timeout等の失敗が確定 |
| `CANCELLED` | graceful cancelが完了し、停止を確認できた |

kSQL-Flowプロセスが結果を返せない場合、`UNKNOWN`をJSONで返したと仮定しない。Control Planeが「有効な結果なし」としてNode Attemptを`UNKNOWN`へ遷移させる。

### 4.2 安定resultCode

| resultCode | status | Exit | 意味 |
| --- | --- | --- | --- |
| `OK` | `SUCCESS` | 0 | 正常完了 |
| `NO_DATA` | `SUCCESS` | 0 | 正常な対象0件 |
| `VALIDATION_ERROR` | `FAILED` | 1 | 引数、設定、SQL検証エラー |
| `ASSERT_FAILED` | `FAILED` | 2 | 業務ASSERT違反 |
| `SQL_ERROR` | `FAILED` | 3 | 実行時SQLエラー |
| `API_ERROR` | `FAILED` | 3 | APIリトライ後の失敗 |
| `AUTH_ERROR` | `FAILED` | 3 | 認証・権限エラー |
| `EXECUTION_TIMEOUT` | `FAILED` | 3 | ランナー自身が検知して中断したtimeout |
| `LOCK_UNAVAILABLE` | `FAILED` | 3 | 分散ロックを確立できずfail-closed |
| `INTERNAL_ERROR` | `FAILED` | 3 | kSQL-Flow内部エラー |
| `CANCELLED` | `CANCELLED` | 3 | graceful cancel |
| `LOCK_CONFLICT` | `FAILED` | 5 | 既存Jobロックとの競合。業務失敗とは別分類 |

Exit 4は現行`run-all`の部分成功用であり、単一`run`契約では生成しない。

Control Planeは`LOCK_CONFLICT`をNode業務失敗として保存せず、Invocationへ記録する。事前作成したNode Attemptは`CANCELLED / PREPARE_FAILED`で確定し、Node Stateをrevision付きで`WAITING`へ戻す。attempt番号はsubprocess起動試行の監査履歴として保持する。

`VALIDATION_ERROR`と`LOCK_CONFLICT`では`executionStarted = false`を必須とする。`executionStarted = true`の`VALIDATION_ERROR`または`LOCK_CONFLICT`は契約違反として`UNKNOWN`にする。その他の失敗は、最初のSQL文への到達状況に応じた値を返す。

### 4.3 拡張resultCode

新しいresultCodeはv1へ追加できる。Control Planeが未知コードを受け取った場合:

- statusとExit Codeが整合すれば、そのstatusを使用し未知コードを保存する。
- statusとExit Codeが矛盾する場合は結果を不正として`UNKNOWN`にする。
- 未知コードを`OK`へフォールバックしない。

---

## 5. Exit Code互換性

現行kSQL-FlowのExit Codeを維持する。

| Exit | 意味 |
| --- | --- |
| 0 | 成功／NO_DATA |
| 1 | 検証エラー |
| 2 | ASSERT違反 |
| 3 | 実行時エラー、timeout、lock unavailable、graceful cancel |
| 4 | run-all部分成功。本契約の単一runでは使用しない |
| 5 | 多重起動・Jobロック競合 |

詳細分類のためにExit Codeを再割当てしない。上位層は`resultCode`を使用する。

---

## 6. stdout、stderr、結果ファイル

### `--result-json -`

- stdoutはUTF-8、BOMなしのJSON object 1個と末尾改行だけとする。
- ANSI escape、進捗、警告、人間向け説明をstdoutへ出さない。
- 人間向け出力はstderrへ出す。
- stderrの文言を機械判定に使用しない。

### `--result-json <path>`

- 同一ディレクトリの一時ファイルへ書き、flush後にatomic renameする。
- 成功時は完成したJSONだけが指定pathに存在する。
- 既存ファイルを暗黙に上書きするかは実装前に決定する。
- Control Planeはprocess exitとファイル内容の両方を検証する。

### controlled failure

`--result-json`を認識できた後の検証・実行失敗では、可能な限りExecution Resultを出力する。CLI parser到達前、OS強制終了、ディスク障害等では結果がない場合がある。

結果なし、JSON破損、schema不一致、ID不一致、Exit Code不一致はControl Planeで`UNKNOWN`とする。ただしSQL実行前だったことを別の耐久証跡から証明できる場合の解決規則はFreeze Decision Recordに従う。

---

## 7. Signalとcancel

### graceful signal

Ctrl+C、SIGINT、SIGTERMを受けた場合:

1. 新しいSQL文・新しい書込chunkを開始しない。
2. 進行中のAPI requestを安全に中断できない場合は完了を待つ。
3. ロックを解放する前に結果とログを確定する。
4. 停止を確認できれば`CANCELLED`結果を返す。

### forced termination

SIGKILL、OS強制終了、ホスト消失、Control Planeのkill timeout等ではJSON結果を保証しない。Control PlaneはNode Attemptを`UNKNOWN`とし、旧プロセス停止確認前に再実行しない。

WindowsとUnixでsignal動作が異なるため、両環境のcontract testを用意する。

### Control Planeの停止手順

```text
graceful signal送信
  ↓ grace period
process終了とresult確認
  ├─ valid CANCELLED result → CANCELLED
  └─ 未終了／結果不明
       ↓ forced kill
       UNKNOWN
```

---

## 8. Correlationとログ

次の関係を相互に追跡可能にする。

```text
Network Run
  └─ Node Attempt
       └─ kSQL-Flow executionId
            └─ JOB record / JSONL statement / chunk events
```

kSQL-FlowのJOBログと安定JSONL eventへ、可能な範囲で次を追加する。

- `correlation_id`
- `attempt_id`
- `execution_id`
- `job_id`
- `runner_execution_started_at`

これらは監査相関用であり、認証、ロックキー、冪等キーとして使用しない。

### 8.1 耐久`EXECUTION_STARTED`イベント

orchestrator経由の実行では、kSQL-Flowは最初のSQL文を開始する直前に、kintone JOBログへ`EXECUTION_STARTED`を永続化し、成功応答を確認してからSQLを開始する。ローカルJSONLにも同じイベントを記録するが、別ホストからの復旧判断における正本はkintone JOBログとする。

```text
JOBログへ EXECUTION_STARTED をrevision付きで更新
        ↓ 成功応答を確認
JSONLへ同イベントを追記
        ↓
SQLの最初の文を開始
```

JOBログ更新の成功を確認できない場合はSQLを開始せず`LOCK_UNAVAILABLE`または`INTERNAL_ERROR`としてfail-closedにする。orchestrator経由では`--lock local-only`を禁止する。

Node Attemptの`execution_started_at`は「orchestratorが実行開始を許可した」マーカーであり、JOBログの`runner_execution_started_at`は「kSQL-FlowがSQL開始直前まで到達した」マーカーである。結果JSONが欠損した場合:

| Node Attempt | JOB `EXECUTION_STARTED` | 判定 |
| --- | --- | --- |
| なし | なし | 未実行。開始準備前のInvocation失敗として記録 |
| あり | なし | 起動失敗を耐久証跡で確定できる場合だけ未実行。それ以外は`UNKNOWN` |
| あり | あり | SQL開始の可能性があるため`UNKNOWN` |

Execution Resultの`executionStarted`は有効な最終JSONがある場合の要約であり、耐久イベントの代替ではない。

---

## 9. Capability negotiation

### 9.1 Capability

提案コマンド:

```bash
ksql-flow capabilities --json
```

出力例:

```json
{
  "formatVersion": 1,
  "kind": "CAPABILITIES",
  "ksqlFlowVersion": "0.x.y",
  "engineVersion": "3.x.y",
  "executionContracts": ["ksql-flow.execution/v1"],
  "features": {
    "resultJson": true,
    "correlationIds": true,
    "gracefulCancel": true,
    "describeProfile": true,
    "inspectJob": true,
    "durableExecutionStarted": true,
    "jobLockProtocol": "J1"
  }
}
```

Control PlaneはNetworkロック取得前に必要capabilityを確認する。要求contractがなければ何も実行せず検証エラーにする。

capability結果をNetwork Run snapshotへ保存する。

### 9.2 resolved profile取得

```bash
ksql-flow describe-profile \
  --profile <profile> \
  --config <config-path> \
  --json
```

出力には、解決済みprofile名、正規化した接続先URL、guest space ID、timezone、論理アプリ名からapp IDへの対応、実行に影響する非秘密limitsを含める。token、password、cookie、Authorization header、秘密鍵は含めない。

orchestratorはNetwork Run作成時の出力をsnapshotへ保存し、resume時に同じコマンドの現在値とcanonical JSON hashを比較する。不一致ならSQLを開始せず、新しいNetwork Runを要求する。orchestratorが`ksql.config.json`の内部schemaを独自に解釈してはならない。

### 9.3 Job inspection

```bash
ksql-flow inspect-job \
  -f <snapshot-sql-path> \
  --profile <profile> \
  --config <config-path> \
  --json
```

出力には、SQLから解決した`jobId`、dialect、構文検証結果、as-ofで固定されない時刻関数、乱数など検出可能な非決定要素を含める。静的検査は冪等性を証明しない。orchestratorは`jobId`とDAGの`job_id`をバンドル作成時に照合し、非決定要素がある`idempotent = true`を拒否するか、認証主体・理由・検査結果を承認済み例外としてmanifestへ固定する。

---

## 10. Securityとログ制限

- token、password、cookie、Authorization headerをJSONへ含めない。
- `error.message`は安全化し、レスポンス本文やSQL literalを無制限に含めない。
- stack traceは既定のExecution Resultに含めない。
- 詳細ログへの参照は、認可された保存先のIDとして渡す。
- SQL pathは秘密情報を含まない相対表示名へ正規化して結果へ出す。
- stdout JSONに顧客レコードの内容を含めない。
- correlation IDをログインジェクションに利用できない文字種へ制限する。

---

## 11. Snapshotとの整合

Control Planeは実行前に次を検証する。

- SQL file SHA-256がmanifestと一致する。
- kSQL-Flow／engine versionが要求範囲を満たす。
- `describe-profile --json`のcanonical JSON hashと、接続先、guest space、app ID、timezoneがsnapshotと一致する。
- as-ofがNetwork Run値と一致する。
- `inspect-job --json`および実行時のSQL論理job IDがDAG nodeの`job_id`と一致する。
- `inspect-job`の非決定要素検査結果がmanifestと一致し、必要な例外承認がある。

kSQL-Flowは渡されたsnapshot SQLを実行する。現在の作業ツリーに同名ファイルがあっても置き換えない。

snapshotは外部データ、権限、kintone設定、外部API応答を固定しない。Execution Resultは再現性の保証ではなく、実際に使用したversion・as-of・profile・件数を記録する。

---

## 12. Contract test

### 正常系

- SUCCESS／OK
- SUCCESS／NO_DATA
- countが0の場合
- `--result-json -`とpath出力
- correlation ID一致
- capability一致
- describe-profileのcanonical hash一致
- inspect-jobのjob ID一致
- `executionStarted = true`と耐久`EXECUTION_STARTED`イベントの相関

### controlled failure

- VALIDATION_ERROR／Exit 1
- ASSERT_FAILED／Exit 2
- API_ERROR／Exit 3
- EXECUTION_TIMEOUT／Exit 3
- LOCK_UNAVAILABLE／Exit 3
- LOCK_CONFLICT／Exit 5
- VALIDATION_ERROR／LOCK_CONFLICTで`executionStarted = false`

### 不正結果

- JSONなし
- JSON途中切れ
- formatVersion不一致
- kind不一致
- correlation ID不一致
- attempt ID不一致
- JSONのexitCodeとprocess exit不一致
- statusとresultCodeの矛盾
- `executionStarted`とresultCodeの矛盾
- countが負数または非整数

### signal／障害

- SQL開始前Ctrl+C
- read中Ctrl+C
- write chunk間Ctrl+C
- API request中SIGTERM
- grace period超過後のforced kill
- stdout pipe切断
- result file書込失敗
- kSQL-Flowログ成功、result出力失敗
- result出力成功、Control Plane受信前クラッシュ
- Node Attempt開始マーカー成功後、JOB `EXECUTION_STARTED`前のクラッシュ
- JOB `EXECUTION_STARTED`成功後、最初のSQL文開始前のクラッシュ
- JOB `EXECUTION_STARTED`更新の応答消失

### Job lock recovery

- 旧保持者停止確認なしのforce-unlock拒否
- force-unlock成功結果と対象lockの一致
- force-unlock失敗結果の安定code
- 解除応答消失後の再照会
- 認証主体、確認者、理由、証拠参照の欠落拒否
- FlowNet監査イベントとkSQL-Flow回復結果の相関

### 互換性

- 対応する最小kSQL-Flow version
- 未対応contract version
- additive unknown field
- unknown resultCode
- 既存`run-all`のExit Code回帰

---

## 13. v1確定前の未決事項

- `--result-json <path>`の既存ファイル上書き規則
- `executionId`の発行時点と形式
- graceful cancelのExit 3内での既存互換性
- JOB `EXECUTION_STARTED`のrevision更新、応答消失、照会手順の詳細
- error codeの最小安定集合
- capability commandの配置とExit Code
- WindowsでのCtrl+C／CTRL_BREAK処理
- JSON Schemaの配布場所とpackage化
- kSQL-Flow JOBログアプリへcorrelation fieldを追加する移行方法
- Job lock force-unlockのCLI、停止確認入力、結果schema、Exit Code、応答消失時の照会方法
- `describe-profile` canonical JSONの正規化規則
- `inspect-job`の検査codeと承認済み例外schema

これらを決定しcontract testを通過した時点で、本書を`ACCEPTED`へ変更する。
