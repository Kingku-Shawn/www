# -*- coding: utf-8 -*-
import io, sys, re

path = r"D:\Code library\shareit\blog\o\cdn-2607\a\0\index-D-3VvwBs.js"

with io.open(path, "r", encoding="utf-8", errors="replace") as f:
    data = f.read()

print("FILE LENGTH (chars):", len(data))
print("=" * 80)

# patterns of interest
patterns = [
    "X-Token",
    "localStorage",
    "setRequestHeader",
    "config.headers",
    "csrf",
    "CSRF",
    "/api/user/info",
    "/api-v1/user/info",
    "user/info",
    "asyncUserInfo",
    "getItem",
    "setItem",
    "removeItem",
    "xw_token",
    "shawn_site_token",
    "_token",
    "Authorization",
    "Bearer",
]

def extract_context(data, pattern, before=300, after=300):
    results = []
    start = 0
    while True:
        idx = data.find(pattern, start)
        if idx == -1:
            break
        lo = max(0, idx - before)
        hi = min(len(data), idx + len(pattern) + after)
        snippet = data[lo:hi]
        results.append((idx, snippet))
        start = idx + len(pattern)
    return results

for pat in patterns:
    res = extract_context(data, pat)
    if res:
        print("\n\n### PATTERN:", repr(pat), "| occurrences:", len(res))
    for idx, snip in res[:3]:  # show up to 3 occurrences each
        print("\n--- @ char offset", idx, "---")
        print(snip)
