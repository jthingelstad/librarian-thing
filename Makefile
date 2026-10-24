.PHONY: blog-round build clean librarian-corpus librarian-corpus-upload librarian-blog-corpus-upload librarian-podcast-import librarian-podcast-corpus librarian-podcast-corpus-upload librarian-reference-import librarian-reference-corpus librarian-reference-corpus-upload librarian-corpora-upload librarian-graph librarian-graph-upload librarian-graph-push librarian-deploy librarian-deploy-full test test-lambda check

PYTHON ?= uv run --locked python

librarian-corpus:
	$(PYTHON) pipeline/corpus/build.py

librarian-corpus-upload:
	$(PYTHON) pipeline/deploy/upload_corpus.py

librarian-blog-corpus-upload:
	$(PYTHON) pipeline/deploy/upload_blog_corpus.py

librarian-podcast-import:
	$(PYTHON) pipeline/podcast/import_another_thing.py

librarian-podcast-corpus:
	$(PYTHON) pipeline/corpus/build_podcast.py

librarian-podcast-corpus-upload:
	$(PYTHON) pipeline/deploy/upload_podcast_corpus.py

# Check reference-documents/ and mirror it into data/reference/ (the round
# pulls main's copy into the library; this one is for a local build).
librarian-reference-import:
	$(PYTHON) pipeline/reference/import_reference.py

librarian-reference-corpus:
	$(PYTHON) pipeline/corpus/build_reference.py

librarian-reference-corpus-upload:
	$(PYTHON) pipeline/deploy/upload_reference_corpus.py

librarian-corpora-upload:
	$(PYTHON) pipeline/deploy/upload_corpus.py
	$(PYTHON) pipeline/deploy/upload_blog_corpus.py
	$(PYTHON) pipeline/deploy/upload_podcast_corpus.py
	$(PYTHON) pipeline/deploy/upload_reference_corpus.py

librarian-graph:
	$(PYTHON) pipeline/graph/build.py

librarian-graph-upload:
	$(PYTHON) pipeline/graph/build.py --upload

# Dry-run diff of graph.json against the website repo; CI pushes with --push.
librarian-graph-push:
	$(PYTHON) pipeline/deploy/push_graph.py

librarian-deploy:
	@if [ -n "$(ARGS)" ] && [ "$(ARGS)" != "--skip-corpus-upload" ]; then echo 'Use librarian-deploy-full for corpora, or invoke aws.py directly for local options.' >&2; exit 1; fi
	gh workflow run deploy.yml --ref main -f scope=code

librarian-deploy-full:
	gh workflow run deploy.yml --ref main -f scope=full

# The Library Agent's blog round: propose categories, alt and Featured
# candidates (a dry run); ARGS="--recheck 10" or ARGS="--write <file>".
blog-round:
	$(PYTHON) pipeline/blog/round/blog_round.py $(ARGS)

# Build every generated Librarian artifact.
build:
	$(PYTHON) pipeline/corpus/build.py
	$(PYTHON) pipeline/corpus/build_reference.py
	$(PYTHON) pipeline/graph/build.py

clean:
	rm -rf cache tmp test-results
	rm -f data/librarian/*.embedded.json
	find . -type d \( -name __pycache__ -o -name .pytest_cache \) -prune -exec rm -rf {} +
	find . -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete

test:
	uv run --locked pytest tests/ -q

test-lambda:
	npm --prefix apps/librarian/lambda run verify

# Everything CI checks locally: lint, format, Python tests, Lambda verify.
check:
	uv run --locked ruff check .
	uv run --locked ruff format --check .
	uv run --locked pytest tests/ -q
	$(MAKE) test-lambda
