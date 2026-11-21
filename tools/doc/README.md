# Intra-frame documentation tooling

The tools under `tools/doc/` maintain the documentation and experiment fixtures
for the DCT intra path **without calling the main encoder**.  Streams are
written from readable coefficient tables, parsed back by an independent parser,
and cross-checked against the production decoder only where a check needs a
second opinion.

## Why it exists

The main encoder, its decoder and the documentation can all agree on the same
mistake.  To prevent that, three things here are deliberately separate
implementations:

| component | file | shares with main code |
|---|---|---|
| miniature writer | `miniwriter.mjs` | only magic/version/order constants |
| parser + directory | `parser.mjs`, `directory.mjs` | transform/quantiser maths only |
| checker + lookup | `checker.mjs` | none beyond those |

A published legacy example (`examples/legacy/blocks-v1.ivc`) is frozen and is
what `side-by-side.mjs` compares against.

## Generate the examples

```
node tools/doc/examples.mjs          # write examples/
node tools/doc/examples.mjs --check  # fail if anything is stale
node tools/doc/docs.mjs --write      # render docs/format-examples.md
```

Fixtures (all in `tools/doc/fixtures.mjs`):

* **minimal** – one 8x8 block, one non-zero level.
* **shared-edge** – two horizontally adjacent blocks.  Block 0 ends on a byte
  boundary with a negative AC level; block 1 predicts from block 0's right
  column (mode H).  Three damages are derived from it:
  * `missing-last-byte.ivc` – the true final byte is lost; the checker reports
    the failure *inside* block 1 (bit 120 of 123).
  * `misaligned-marker.ivc` – the byte count is unchanged but one bit was
    deleted from block 1, so its end marker sits early; the checker reports the
    failure at the stored end (bit 128).
  * `shared-edge-flip.ivc` – one bit in block 0's last AC codeword is inverted.
    Block 1's own codewords and bit range are untouched, yet its predicted
    pixels change.  The decode still reports success.
  * `unknown-version.ivc` – the version field is 2; the checker rejects it at
    bits [32,36) and reports no block failure.
* **legacy** – the frozen published example.

## Check and trace

```
node tools/doc/check.mjs check   examples/shared-edge/stream.ivc
node tools/doc/check.mjs check   examples/shared-edge/unknown-version.ivc
node tools/doc/check.mjs check   examples/shared-edge/missing-last-byte.ivc
node tools/doc/check.mjs lookup  examples/shared-edge/stream.ivc 8 0
node tools/doc/check.mjs explain examples/shared-edge/shared-edge-flip.ivc examples/shared-edge/stream.ivc 8 0
node tools/doc/check.mjs directory examples/shared-edge/missing-last-byte.ivc
node tools/doc/check.mjs seek    examples/shared-edge/stream.ivc 1
```

`lookup` names the coefficient that moves a pixel most and its exact bit range.
`explain` attributes a wrong pixel in a damaged stream to the field of the
intact stream whose bits were disturbed (here: block 0, AC coefficient z=2,
bits 105..112).

## Directory contract for a frame indexer

`buildDirectory` publishes a block only after three independent checks pass:

1. **reparse** – a fresh bounded reader over exactly `[startBit,endBit)`
   consumes the range exactly and reproduces the token;
2. **cross** – the production decoder reports the same bit range;
3. **pixels** – this parser's reconstruction matches the production decoder's.

An entry that fails any check stays `locatable` but not `published`;
`seekBlock` refuses it.  A truncated tail therefore cannot be used as a seek
point by construction.

## Quantiser changes

```
node tools/doc/quantiser.mjs                              # current src/quant.js
node tools/doc/quantiser.mjs --table new.json --diff old.json
node tools/doc/quantiser.mjs --table new.json --diff old.json --write
```

Re-quantises the documented samples against the new steps and reports, per
sample, whether the stream length changed and whether the **old decoder still
produces the original pixels** from the rebuilt stream.

## Side-by-side with the published example

```
node tools/doc/side-by-side.mjs
```

Prints the raw bit string the parser sees next to `examples/legacy/blocks-v1.ivc`,
byte by byte, labelled with the field each byte begins in, and verifies that the
two agree on the grammar.

## Tests

```
node tests/all.mjs
```
