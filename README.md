# agentive-academy-render

Batch renderer for Agentive Academy lesson videos (16:9 hand-drawn explainers). Run it manually from the Actions tab: **render**, then **Run workflow**.

- `kit/`: the render pipeline (voice, sketch animation, sound, mix, checks). Third-party licences are listed in `kit/NOTICE.md`.
- `data/lessons.tgz.enc`: the lesson scripts, encrypted. The workflow decrypts them with the `LESSON_KEY` repository secret.
- `ci/render_chunk.sh`: renders one chunk of lessons and uploads each finished lesson, encrypted, to its chunk's release, `renders-<chunk>`.

The outputs are encrypted draft files. Nothing is published from this repository.

The repository's own code is all rights reserved. Third-party components keep their own licences.
