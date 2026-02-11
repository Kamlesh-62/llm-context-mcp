# Project Docs for Kids

This file explains this project in super simple words.

## Imagine this

You have 3 robot helpers:

- Claude
- Codex
- Gemini

They help you write code.

Problem: each robot forgets things between chats.

## What this project does

This project is a **memory notebook server** for your coding projects.

It lets all 3 robots read and write the same notebook file:

- `.ai/memory.json`

So if one robot learns something, another robot can read it later.

## Where memory is saved

Memory is saved in the project you are working on.

Example:

- If you work in `/Users/itsupport4/Documents/opulence_api`
- Memory is saved in `/Users/itsupport4/Documents/opulence_api/.ai/memory.json`

Not in this MCP server folder (unless you run it from here).

## Important: what is NOT auto-saved

Your full chat is **not** saved automatically.

Only things saved by memory tools are written to `memory.json`, like:

- `memory_save`
- approved proposals (`memory_propose` + `memory_approve_proposal`)

So if you want something remembered, ask the model to call `memory_save`.

## Easy daily steps

1. Open your coding project.
2. Start Claude or Gemini in that project folder.
3. Ask tool `memory_get_bundle` to read old memory.
4. Do your coding work.
5. Ask tool `memory_save` to store important results.

## Super simple example

You found versions:

- PHP: `7.4.33`
- Laravel: `5.6.40`

Ask your model:

```text
Call MCP tool `memory_save` with:
- title: "Project runtime versions"
- type: "fact"
- content: "PHP version is 7.4.33 and Laravel version is 5.6.40."
- tags: ["php","laravel","environment","version"]
- source: "claude"
```

Now any model can search it later using `memory_search`.

## What is MCP (kid version)

MCP is like a phone line between your AI and tools.

- AI says: "Please run memory_save."
- MCP server does it.
- AI gets the result.

That is how Claude/Gemini/Codex can use this memory notebook.

## Why this helps

- Less repeating the same context
- Same memory for different models
- Works on your local machine
- Memory stays inside each project
