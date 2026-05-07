# CDEvent Schemas

Iron Monkey validates every planned event against a per-event JSON Schema before emitting anything.

## Default location

Schemas are bundled in `schemas/cdevents/` relative to the installed package. The path is overridable via environment variable or flag:

```bash
IRON_MONKEY_SCHEMAS=/path/to/my/schemas iron-monkey run workflow.yaml
```

## How schema lookup works

The loader reads every `.json` file in the schemas directory at startup and indexes each one by the event type string found in `context.type.enum[0]`. Filenames are irrelevant to lookup — only the type enum inside the schema matters.

So given a schema file containing:

```json
"type": {
  "enum": ["dev.cdevents.pipelinerun.finished.0.3.0"]
}
```

any workflow event with `type: dev.cdevents.pipelinerun.finished.0.3.0` will be validated against that schema, regardless of what the file is named.

## Bundled schemas

The bundled set comes from the CDEvents 0.6.0-draft spec and uses short camelCase filenames:

```
pipelinerunfinished.json   →  dev.cdevents.pipelinerun.finished.0.3.0
pipelinerunstarted.json    →  dev.cdevents.pipelinerun.started.0.3.0
buildstarted.json          →  dev.cdevents.build.started.0.3.0
artifactpackaged.json      →  dev.cdevents.artifact.packaged.0.3.0
servicedeployed.json       →  dev.cdevents.service.deployed.0.3.0
...
```

The file `baseevent.json` is a Conduit-specific base schema and is not part of the per-event lookup.

## Schema format

Schemas must follow the CDEvents 0.6.0-draft shape and use **JSON Schema 2020-12** (`"$schema": "https://json-schema.org/draft/2020-12/schema"`):

- `context` requires `specversion`, `id`, `source`, `type`, `timestamp`; `chainId`, `links`, `schemaUri` are optional
- `context.links` is an array of link objects (`type` + `target`), referenced via `$ref: "links/embeddedlinksarray"` — Iron Monkey registers this definition with AJV automatically
- `subject` requires `id` and `content`; `source` is optional; no `type` field on subject
- `additionalProperties: false` on both `context` and `subject`

## Adding new schemas

1. Get the schema from the [CDEvents spec repository](https://github.com/cdevents/spec) or author one following the shape above.
2. Drop the file in `schemas/cdevents/` (any filename ending in `.json`).
3. The type string inside the schema (`context.type.enum[0]`) must match the event type used in your workflow YAML.

Iron Monkey picks it up automatically on next run — no registration step needed.

## Error on missing schema

If a workflow references an event type for which no schema is found:

```
Error: No schema found for event type 'dev.cdevents.foo.bar.0.1.0'.
Place the schema at schemas/cdevents/ or set IRON_MONKEY_SCHEMAS.
```
