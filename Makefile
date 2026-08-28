.PHONY: build clean librarian-corpus librarian-corpus-upload librarian-blog-corpus-upload librarian-podcast-import librarian-podcast-corpus librarian-podcast-corpus-upload librarian-corpora-upload librarian-graph librarian-graph-upload librarian-graph-push librarian-deploy test test-lambda

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

librarian-corpora-upload:
	$(PYTHON) pipeline/deploy/upload_corpus.py
	$(PYTHON) pipeline/deploy/upload_blog_corpus.py
	$(PYTHON) pipeline/deploy/upload_podcast_corpus.py

librarian-graph:
	$(PYTHON) pipeline/graph/build.py

librarian-graph-upload:
	$(PYTHON) pipeline/graph/build.py --upload

# Dry-run diff of graph.json against the website repo; CI pushes with --push.
librarian-graph-push:
	$(PYTHON) pipeline/deploy/push_graph.py

librarian-deploy:
	$(PYTHON) pipeline/deploy/aws.py $(ARGS)

# Build every generated Librarian artifact.
build:
	$(PYTHON) pipeline/corpus/build.py
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
