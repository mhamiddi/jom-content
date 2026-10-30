# Jom Content — Content Dashboard (Jom Digital)

Kau guna Codex CLI dalam project ni untuk maintain dan audit content di jom-content.com.

## Context

- **App:** jom-content.com — Centralised content dashboard untuk Jom Digital (Middi / @hamiddi_)
- **Platforms:** TikTok + Threads + Facebook Page + Instagram (Meta via /api/meta-publish)
- **Pillars (canonical 3):** Google Ads & Marketing 35% / Agentic AI 35% / Engage 30%
- **Theme:** Jom Digital brand — primary #2563EB, accent #22C55E, Montserrat (headings) + DM Sans (body)
- **Login:** username `jomdigital` — password disimpan dalam vault/secure note owner, JANGAN tulis plaintext dalam repo
- **API Base:** https://jom-content.com/api/posts (CF Pages Functions + KV namespace `jom-content-posts`)
- **Content source of truth:** `~/projects/jom-content/`

## Rules

1. Content source of truth = working file dalam `~/projects/jom-content/`. Jangan guna deployed version.
2. Platform: TikTok + Threads + Facebook Page + Instagram. Media untuk Meta di-host di R2 (`media.jom-content.com`), upload melalui /api/media-upload.
3. AI signatures MESTI dibuang — no emdash (—), no smart quotes, no "Jadi,", no "adalah" copula, no "Ianya", no "Kini," openers.
4. No duplicate titles — audit dulu sebelum add post baru.
5. Setiap topic kena unique, varied angle, ada engagement mini-tip.
6. Tone ikut Middi content DNA (casual BM rojak, ayat pendek, bukan esei).
