# Claude Code統合

Spring MouseをClaude Code CLIと統合し、AnthropicのAPIリクエストをSpring Mouseのインテリジェントルーティングシステム経由でルーティングします。

## 前提条件

- Claude Code CLIがインストール済み
- Spring Mouseがローカルで動作中、またはクラウドエンドポイントが設定済み
- Spring MouseダッシュボードからのAPIキー

## セットアップ

### 1. 環境変数を設定

シェル設定ファイル (`~/.bashrc`、`~/.zshrc`、または `~/.bash_profile`) で以下の環境変数を設定:

```bash
# Spring Mouse用Base URL
export ANTHROPIC_BASE_URL="http://localhost:8008/v1"

# オプション: エイリアス用のデフォルトモデルを設定
export ANTHROPIC_DEFAULT_OPUS_MODEL="cc/claude-opus-4-5-20251101"
export ANTHROPIC_DEFAULT_SONNET_MODEL="cc/claude-sonnet-4-5-20250929"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="cc/claude-haiku-4-5-20251001"
```

### 2. シェル設定をリロード

```bash
source ~/.zshrc  # または ~/.bashrc
```

### 3. 設定を確認

環境変数が正しく設定されているか確認:

```bash
echo $ANTHROPIC_BASE_URL
```

## モデルエイリアス

Claude CodeはSpring Mouseモデルにマッピングされる以下のモデルエイリアスをサポート:

| エイリアス | モデル | 環境変数 |
|-------|-------|---------------------|
| `opus` | Claude Opus 4.5 | `ANTHROPIC_DEFAULT_OPUS_MODEL` |
| `sonnet` | Claude Sonnet 4.5 | `ANTHROPIC_DEFAULT_SONNET_MODEL` |
| `haiku` | Claude Haiku 4.5 | `ANTHROPIC_DEFAULT_HAIKU_MODEL` |

## 使用例

### モデルエイリアスを使用

```bash
# Opusモデルを使用
claude --model opus "Explain quantum computing"

# Sonnetモデルを使用
claude --model sonnet "Write a Python function"

# Haikuモデルを使用
claude --model haiku "Quick code review"
```

### フルモデル名を使用

```bash
claude --model cc/claude-opus-4-5-20251101 "Your prompt here"
```

## 設定ファイル

Claude Codeは設定を `~/.claude/settings.json` に保存します。必要に応じてこのファイルを手動で編集できます:

```json
{
  "baseUrl": "http://localhost:8008/v1",
  "defaultModel": "sonnet"
}
```

## トラブルシューティング

### 接続の問題

接続エラーが発生した場合:

1. Spring Mouseが動作中か確認: `curl http://localhost:8008/health`
2. 環境変数が正しく設定されているか確認
3. ファイアウォールがポート8008をブロックしていないか確認

### モデルが見つからない

「model not found」エラーが発生した場合:

1. モデル名がSpring Mouseの設定と一致しているか確認
2. Spring Mouseダッシュボードでプロバイダー接続がアクティブか確認
3. 接続されたプロバイダーでモデルが利用可能か確認

## クラウドエンドポイント

localhostの代わりにSpring Mouseクラウドエンドポイントを使用するには:

```bash
export ANTHROPIC_BASE_URL="https://spring-mouse.com"
```

Spring MouseクラウドダッシュボードでAPIキーが設定されていることを確認してください。
