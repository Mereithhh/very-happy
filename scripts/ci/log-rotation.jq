# B-827: names every service of a rendered compose config (docker compose
# config --format json) whose container log is not rotated. A json-file log
# without max-size grows until the disk is full.
.services | to_entries[]
| select(
    (((.value.logging.driver // "json-file") | IN("json-file", "local")) | not)
    or (((.value.logging.options["max-size"] // "") | test("^[0-9]+[kmg]$")) | not)
    or (((.value.logging.options["max-file"] // "") | test("^[0-9]+$")) | not)
  )
| .key
