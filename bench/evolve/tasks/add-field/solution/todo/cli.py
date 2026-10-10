import argparse
import sys

from todo.export import to_csv
from todo.model import Task
from todo.storage import load, save


def main(argv, store, out=None):
    """Runs one command (add, done, list, export) on the tasks saved in `store`."""
    out = out or sys.stdout
    parser = argparse.ArgumentParser(prog="todo")
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("add")
    add.add_argument("title")
    add.add_argument("--priority", choices=["low", "normal", "high"], default="normal")
    done = commands.add_parser("done")
    done.add_argument("number", type=int)
    commands.add_parser("list")
    export = commands.add_parser("export")
    export.add_argument("path")
    args = parser.parse_args(argv)
    tasks = load(store)
    if args.command == "add":
        tasks.append(Task(args.title, priority=args.priority))
        save(tasks, store)
    elif args.command == "done":
        tasks[args.number - 1].done = True
        save(tasks, store)
    elif args.command == "list":
        for number, task in enumerate(tasks, 1):
            tag = "" if task.priority == "normal" else f"[{task.priority}] "
            print(f"{number}. [{'x' if task.done else ' '}] {tag}{task.title}", file=out)
    elif args.command == "export":
        with open(args.path, "w") as handle:
            handle.write(to_csv(tasks))
