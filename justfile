dsh := env_var_or_default("DSH_BIN", "dsh")

# Link this checkout into the DSH TUI profile.
install:
    {{dsh}} plugin --profile tui add "{{justfile_directory()}}"
