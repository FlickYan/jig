# Configuration

| Setting | Environment variable | Flag | Default |
|---------|----------------------|------|---------|
| host | APP_HOST | --host | localhost |
| retry_limit | APP_RETRY_LIMIT | --retry-limit | 3 |
| timeout | APP_TIMEOUT | --timeout | 10 |

`retry_limit` is how many times a failed request is tried again. The old names, `APP_MAX_RETRIES` and `--max-retries`, still work but are deprecated.
