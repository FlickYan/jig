# Using todo

- `todo add "Buy milk"` adds a task; `--priority low|normal|high` sets its priority (normal by default).
- `todo done 1` marks task 1 as done.
- `todo list` shows the tasks, with low and high priorities as a tag: `1. [x] [high] Buy milk`.
- `todo export tasks.csv` writes them to a CSV file with the columns `title`, `priority` and `done`.
