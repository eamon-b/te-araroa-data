# Licensing of the data

The code in `src/` is MIT (see `LICENSE`). The data is not mine to relicense,
and different files in `out/` derive from different sources. This file says
which is which, so that anyone building on it knows what they are agreeing to.

## The trail itself

**Source:** Te Araroa Trust, 2026-27 release (v45).
**Declared licence:** the trust's own GPX carries this in its metadata:

```xml
<copyright author="Te Araroa Trust ">
  <year>2026</year>
  <license>Creative Commons 4.0 New Zealand</license>
```

**A caveat worth stating plainly:** "Creative Commons 4.0 New Zealand" is not a
licence identifier that exists. Creative Commons 4.0 is unported - there is no
New Zealand port of it, the NZ jurisdiction ports having stopped at 3.0 - and
the string does not say *which* CC licence is meant. BY, BY-SA and BY-NC all
carry very different obligations for anyone reusing this.

This project reads that as the attribution-style licence it most plausibly
means, and attributes the trust everywhere accordingly. That is an
interpretation, not a legal opinion, and it has not been confirmed with the
trust. If you are planning a commercial use, ask them first:
<info@teararoa.org.nz>.

The trust's own KMZ and GPX are deliberately **not** redistributed here.
`npm run fetch` downloads them from teararoa.org.nz at build time, so the trust
stays the publisher of its own files and you always get the current release.

## Huts and campsites

**Source:** New Zealand Department of Conservation, via the attributes the trust
embeds in its KMZ. DOC publishes its hut and campsite data under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Practical note: the DOC facility attributes travel through the trust's KMZ, so
they are as current as the trust's release, not as current as DOC's own API.

## Resupply points

**Source:** `data/resupply.json` - researched by hand for this project, because
the official data contains no towns or shops at all.

The research and the notes are mine, offered under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The **coordinates**
are not: they are OpenStreetMap geocodes, © OpenStreetMap contributors, under
the [Open Database Licence](https://opendatacommons.org/licenses/odbl/). ODbL is
share-alike, so if you redistribute a database derived from those coordinates,
that obligation follows you. The trail guides the notes were compiled from are
credited in `sources` inside the file.

## What that means for the files in out/

| File | Derived from | Attribute |
|---|---|---|
| `te-araroa-2026-27.gpx` | trust route + DOC sites + resupply | all three |
| `te-araroa.meta.json` | as above | all three |
| `no-camping-areas.geojson` | trust | Te Araroa Trust |
| `sections.csv` | trust | Te Araroa Trust |
| `resupply-plan.csv` | all three | all three, incl. OSM/ODbL |
| `datasheet.csv`, `datasheet-resupply.csv` | all three | all three, incl. OSM/ODbL |

A single attribution line that covers everything:

> Trail data © Te Araroa Trust. Hut and campsite data © NZ Department of
> Conservation (CC BY 4.0). Resupply coordinates © OpenStreetMap contributors
> (ODbL). Built by te-araroa-data.
