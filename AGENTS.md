# Scriptorium Atlas — 実装エージェント向け

最上位の製品/完成契約は `docs/goals/ATLAS-V1.md`、機能台帳は `docs/architecture/FEATURES-V1.md`、判定は `docs/quality/ACCEPTANCE-V1.md`。変更前に必要な契約のみ読む。セッションの会話を新たな権限・スコープと見なさない。

- Atlasは汎用Graph/Canvas、Story Knowledgeは独立した物語管理アプリ。**相互の実装をimportしない**。データ共有は公開Graph Provider契約とHost仲介のみ。
- ScriptoriumのGit/Recovery/認可/単一WriterはScriptorium Coreが所有。Standalone用の実IndexedDB保存はその代替・本番再実装ではない。
- 今回**設計文書のみ**mainへの直接commitをユーザーが許可した。実装のmain直書きや無断mergeを許可したわけではない。後続実装は独立branch/worktree、PR提出。
- 他リポジトリの変更、本番deploy、認証情報、ユーザー原稿の取得は禁止。Inariエージェント利用は組織方針で停止中。
- 未実装のScriptorium SDKを架空のMockで本番統合済みと主張しない。Standaloneは本物の保存・UI・操作・失敗復旧を実証する。
- 無用な独自Gitエンジン、独自Sandbox、Canvas/Graphライブラリ自作はしない。
- Goalの31機能・品質ゲート15件を無断で削減・緩和しない。実装方法は変更可能。仕様矛盾を発見したら証拠と最小の改訂案を報告し、他の独立タスクは進める。
- 生ログ・大量gzip・生成巨大ファイルをGitへ追加しない。Manifest、要約、ハッシュ・再現方法のみ残す。
- 最終HEAD上で型・build・単体・実Browser E2E・保存復元・各profile closureを検証。測れない項目は NOT_CHECKED、失敗はFAIL。PR=完成ではない。

遵守: `yohn-jp/.github/.github/agent-governance/AGENTS.md`。開発開始時に本リポジトリのmain/current branchesを確認し、衝突と既存進捗を尊重する。
