# P0 offline extraction corpus

These documents and the query manifest are original synthetic test
fixtures created for this repository. They are covered by the
repository's MIT license in `../../../../LICENSE`. No third-party page
text, donor implementation, or production content was copied.

`.test` URLs are inert source identifiers, not fetch targets. Do not
execute scripts or follow links, images, canonical tags, or quoted
instructions. `untrusted.html.fixture` intentionally contains hostile
source text to test that boundary in a later parser implementation.

`manifest.json` defines the fixed query set, human-authored evidence
anchors, source URLs, and expected disposition. Anchors are test
expectations, **not measured extractor output**. P0 validates corpus
integrity only. Extraction quality, clean Markdown, auxiliary-network
denial, and latency remain UNVERIFIED until a parser is approved and
exercised. Empty/no-hit queries require labelled previews in P1;
challenge/empty pages must not become invented successful articles.

The `.html.fixture` suffix deliberately keeps source bytes out of HTML
auto-formatting. Formatting would corrupt the malformed-input case and
change the checksum-pinned corpus. No formatter or runtime
configuration is weakened for these data files.

The corpus is deliberately small and inspectable. P3 still requires
bounded deep/large HTML, compression, charset, transport and worker
resource fixtures; this corpus does not replace those safety tests.
