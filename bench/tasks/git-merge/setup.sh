#!/bin/bash
# Two branches that change the same lines: `feature` rewords the greeting, `main` adds logging.
set -e
git checkout -q -b feature
python3 - <<'EOF'
text = open("app.py").read()
open("app.py", "w").write(text.replace('return f"Hello, {name}."', 'return f"Hi {name}, welcome back!"'))
EOF
git commit -qam "Friendlier greeting"
git checkout -q main
python3 - <<'EOF'
text = open("app.py").read()
text = text.replace("import sys\n", 'import logging\nimport sys\n\nlog = logging.getLogger("app")\n')
text = text.replace('def greet(name):\n    return', 'def greet(name):\n    log.info("greeting %s", name)\n    return')
text = text.replace("def main(argv):\n", 'def main(argv):\n    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")\n')
open("app.py", "w").write(text)
EOF
git commit -qam "Log each greeting"
