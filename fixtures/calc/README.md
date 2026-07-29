# calc — G2: Fix a planted failing test

This project has a deliberately broken test. The `mul` test expects
`mul(2, 3) === 5`, but `mul(a, b)` correctly returns `a * b` (6).

**Goal:** Fix the test expectation (not the source) so all three tests pass.

**Run:** `node --test src/calc.test.js`
