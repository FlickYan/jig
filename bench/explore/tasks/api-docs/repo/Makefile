.PHONY: test docs

test:
	python3 -m unittest discover -s tests

docs:
	python3 tools/gen_api.py ledger > docs/api.md
