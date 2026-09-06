"""Static Docker contract checks; actual image builds need a Docker daemon."""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parent.parent


class ImageTests(unittest.TestCase):
    def test_build_context_is_deny_by_default(self):
        patterns = [line.strip() for line in (ROOT / ".dockerignore").read_text().splitlines() if line.strip() and not line.startswith("#")]
        self.assertEqual(patterns[0], "**")
        self.assertEqual(
            {line for line in patterns if line.startswith("!")},
            {"!package.json", "!pnpm-lock.yaml", "!pnpm-workspace.yaml", "!patches/", "!patches/*.patch", "!tsconfig.json", "!vite.config.ts", "!src/", "!src/**/", "!src/**/*.ts", "!docker/", "!docker/start.py", "!docker/requirements.txt"},
        )
        for pattern in ("**/.env", "**/.env.*", "**/.hermes", "**/.hermes/**", "**/.local", "**/.local/**"):
            self.assertIn(pattern, patterns)

    def test_image_installs_pinned_runtime_at_build(self):
        dockerfile = (ROOT / "Dockerfile").read_text()
        self.assertIn("COPY patches ./patches", dockerfile)
        self.assertLess(dockerfile.index("COPY patches ./patches"), dockerfile.index("pnpm install"))
        self.assertNotIn("uv tool run", dockerfile)
        self.assertNotIn("envsubst", dockerfile)
        self.assertNotIn("COPY . .", dockerfile)
        self.assertIn("pip install --no-cache-dir -r /tmp/mcpo-requirements.txt", dockerfile)
        self.assertIn('CMD ["python3", "/app/docker/start.py"]', dockerfile)
        self.assertIn("USER node", dockerfile)
        requirements = (ROOT / "docker/requirements.txt").read_text().splitlines()
        pins = [line for line in requirements if line and not line.startswith("#")]
        self.assertTrue(all(re.fullmatch(r"[A-Za-z0-9_.-]+(?:\[[a-z]+\])?==[0-9.]+", line) for line in pins))
        self.assertIn("mcpo==0.0.20", pins)
        self.assertIn("mcp[cli]==1.29.1", pins)


if __name__ == "__main__":
    unittest.main()
