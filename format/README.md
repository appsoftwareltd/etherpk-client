# EtherPK Format

The EtherPK Format is how EtherPK keeps a knowledge graph as plain files: a folder of
GitHub-flavoured Markdown documents, linked by `[[wikilinks]]`, that a person and a coding agent
can both read and write. Its specification is at <https://docs.etherpk.com/etherpk-format>.

This folder holds what a program needs to check that it reads the format as EtherPK does.

| Path | Contents |
| --- | --- |
| `example/` | A small graph folder: a journal entry, four pages and one image |
| `expected.json` | The names, links and tasks a reader gets from `example/` |

The example covers a page named by its `title`, a page named by its file name, an alias, a scoped
concept, a link inside code, tasks with priority, state and date tags, subtasks and task comments. The
specification describes each field of `expected.json`.

EtherPK's own tests read `example/` with the code the app runs and compare what they get with
`expected.json`, in `apps/client/src/lib/storage/fs/format-example.test.ts`. The two files are for
version 1 of the format.

## Licence

The specification, `example/` and `expected.json` are available under the [MIT License](LICENSE). So
are the two parts of this repository that people copy into folders of their own: the EtherPK section
of `AGENTS.md` (`apps/client/src/lib/storage/fs/agents-md-section.md`) and the agent skill's starter
folders (`skills/etherpk/assets/`).
