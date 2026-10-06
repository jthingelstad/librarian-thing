"""Shared helpers for the WT23-130 repair rounds: emails <-> archive."""
import json, re, sys
sys.path.insert(0, '/tmp/wtq/audit')
import importlib.util
spec = importlib.util.spec_from_file_location('audit', '/tmp/wtq/audit/audit.py')
A = importlib.util.module_from_spec(spec); spec.loader.exec_module(A)
from bs4 import BeautifulSoup, NavigableString, Comment

import os
ISS = os.environ.get('WTQ_ISS', A.ISS)
INV = json.load(open('/tmp/wtq/audit/inventory.json'))

def email_path(n):
    rows = [e for e in INV['emails'] if str(e.get('issue')) == str(n) and not e.get('dup')]
    return rows[0]['file'] if rows else None

def soup_of(n):
    s = BeautifulSoup(A.email_html(email_path(n)), 'html.parser')
    for t in s(['style', 'script', 'head', 'title']): t.decompose()
    for t in s.find_all(style=re.compile(r'display:\s*none', re.I)): t.decompose()
    return s

def read(n):
    t = open(f'{ISS}{n}/archive.md', encoding='utf-8').read()
    i = t.index('---', 3) + 3
    return t[:i], t[i:]

def W(s):
    return A.words(s)
