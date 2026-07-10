#!/usr/bin/env python3
import sys
sys.stdout.reconfigure(encoding='utf-8')

target = '/home/hamiddi/projects/jom-content/index.html'

html = """<!DOCTYPE html>
<html lang="ms" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Jom Content — Social Media Manager</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&amp;display=swap" rel="stylesheet">
"""
with open(target, 'w', encoding='utf-8') as f:
    f.write(html)
print("Header written")
