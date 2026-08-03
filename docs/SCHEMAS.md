# CDEvent Schemas

Iron Monkey validates every planned event against a per-event JSON Schema before emitting anything.

## Default location

Schemas are bundled in `schemas/cdevents/` relative to the installed package. The path is overridable via environment variable:

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

Iron Monkey ships with 45 CDEvents 0.6.0-draft schemas covering all standard event types. A representative sample:

```
pipelinerunstarted.json    →  dev.cdevents.pipelinerun.started.0.3.0
pipelinerunqueued.json     →  dev.cdevents.pipelinerun.queued.0.3.0
pipelinerunfinished.json   →  dev.cdevents.pipelinerun.finished.0.3.0
buildstarted.json          →  dev.cdevents.build.started.0.3.0
buildfinished.json         →  dev.cdevents.build.finished.0.3.0
testsuiterunstarted.json   →  dev.cdevents.testsuiterun.started.0.3.0
testsuiterunfinished.json  →  dev.cdevents.testsuiterun.finished.0.3.0
artifactpackaged.json      →  dev.cdevents.artifact.packaged.0.3.0
artifactpublished.json     →  dev.cdevents.artifact.published.0.3.0
taskrunstarted.json        →  dev.cdevents.taskrun.started.0.3.0
taskrunfinished.json       →  dev.cdevents.taskrun.finished.0.3.0
servicedeployed.json       →  dev.cdevents.service.deployed.0.3.0
servicepublished.json      →  dev.cdevents.service.published.0.3.0
...
```

`baseevent.json` is a Conduit-specific base schema used for chainId validation and is not part of the per-event type lookup.

### Required subject.content fields by event type

Some event types enforce required fields in `subject.content`. Key ones:

| Event type | Required content fields |
|---|---|
| `pipelinerun.started` | `pipelineName` (string), `uri` (URI) |
| `testsuiterun.started` | `environment.id` (string) |
| `testsuiterun.finished` | `outcome` (enum: success/failure/cancel/error), `environment.id` (string) |
| `artifact.packaged` | `change.id` (string) |
| `service.deployed` | `environment.id` (string), `artifactId` (string) |

All other bundled types have no required content fields. Schemas use `additionalProperties: false` so unknown fields will fail validation.

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
Error: No schema found for event type 'dev.cdevents.foo.bar.0.1.0-draft'.
Place the schema at schemas/cdevents/ or set IRON_MONKEY_SCHEMAS.
```
