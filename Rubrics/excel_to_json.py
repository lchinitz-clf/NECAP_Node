#!/usr/bin/env python3
"""
excel_to_json.py

Pulls one sheet out of an Excel workbook and turns it into the
idealProposals.json-style shape used by the local-rag app:

    {
      "attributes": [
        {"name": "...", "proposal": "..."},
        ...
      ]
    }

Usage:
    python excel_to_json.py <workbook.xlsx> <sheet_name> <name_columns> <proposal_column> [-o output.json]

Example (matches the command you described):
    python excel_to_json.py File.xlsx Questions_full Dimension,Component Question

    - Reads the "Questions_full" sheet out of File.xlsx.
    - For each row, combines the "Dimension" and "Component" column
      values into the "name" field (joined with " - ").
    - Uses the "Question" column as the "proposal" field.
    - Writes the result to Questions_full.json (see --output below to
      pick a different path).

Column-combining format:
    When more than one column is given for <name_columns> (comma-
    separated, no spaces around the commas), each row's values for
    those columns are joined with " - ", e.g. Dimension="Governance"
    and Component="Funding" becomes the name "Governance - Funding".
    Change JOIN_SEPARATOR below if you'd rather use something else
    (e.g. ": " or " / ").

Duplicate names:
    If the same combined name shows up on more than one row (the
    Dimension/Component pair repeats, say, across several Question
    rows), the first occurrence keeps the plain name and every
    occurrence after that gets " (n)" appended (the 2nd occurrence
    becomes "name (2)", the 3rd "name (3)", and so on) so every entry
    in the output is still uniquely identifiable.

Skipped rows:
    A row is skipped (and reported at the end) if its proposal column
    is empty, or if every one of its name columns is empty — there's
    nothing meaningful to put in "name"/"proposal" for a row like
    that. Individual empty name columns within an otherwise-usable
    row are just left out of the join rather than skipping the row.

Requirements:
    pip install pandas openpyxl
"""

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

# Joins multiple name-column values together when name_columns has
# more than one column in it. See "Column-combining format" above.
JOIN_SEPARATOR = " - "


def parse_args():
    parser = argparse.ArgumentParser(
        description="Convert one sheet of an Excel workbook into an idealProposals-style JSON file."
    )
    parser.add_argument("workbook", help="Path to the .xlsx file")
    parser.add_argument("sheet", help="Sheet (tab) name to read")
    parser.add_argument(
        "name_columns",
        help='Column name, or comma-separated list of column names (no spaces), '
             'to combine into the "name" field. Example: Dimension,Component',
    )
    parser.add_argument("proposal_column", help='Column name to use as the "proposal" field')
    parser.add_argument(
        "-o", "--output",
        help="Output JSON file path. Defaults to <sheet>.json in the current directory.",
        default=None,
    )
    return parser.parse_args()


def clean_cell(value):
    """
    Normalizes one cell's value into a stripped string, or None if the
    cell is genuinely empty. pandas represents a blank Excel cell as
    NaN (a float), not an empty string, so this also catches that —
    str(nan) would otherwise produce the literal text "nan" showing up
    in your output, which is never what you want here.
    """
    if pd.isna(value):
        return None
    text = str(value).strip()
    return text or None


def build_name(row, name_columns):
    """
    Combines the given columns' values for one row into the "name"
    field. Empty individual columns are skipped rather than leaving a
    stray separator behind (e.g. Dimension="Governance", Component=""
    becomes just "Governance", not "Governance - ").
    Returns None if every one of the name columns was empty for this
    row — the caller treats that as "skip this row".
    """
    parts = [clean_cell(row[col]) for col in name_columns]
    parts = [p for p in parts if p is not None]
    if not parts:
        return None
    return JOIN_SEPARATOR.join(parts)


def main():
    args = parse_args()
    name_columns = args.name_columns.split(",")

    workbook_path = Path(args.workbook)
    if not workbook_path.exists():
        sys.exit(f"Error: workbook not found: {workbook_path}")

    try:
        df = pd.read_excel(workbook_path, sheet_name=args.sheet)
    except ValueError as err:
        # pandas raises ValueError for an unknown sheet name, and lists
        # the sheets that DO exist in its own message — surfaced as-is
        # since it's already exactly the information needed to fix this.
        sys.exit(f"Error reading sheet: {err}")

    missing_columns = [c for c in name_columns + [args.proposal_column] if c not in df.columns]
    if missing_columns:
        sys.exit(
            f"Error: column(s) not found in sheet '{args.sheet}': {', '.join(missing_columns)}\n"
            f"Columns available: {', '.join(str(c) for c in df.columns)}"
        )

    attributes = []
    seen_counts = {}
    skipped_rows = 0

    for _, row in df.iterrows():
        proposal = clean_cell(row[args.proposal_column])
        base_name = build_name(row, name_columns)

        if proposal is None or base_name is None:
            skipped_rows += 1
            continue

        seen_counts[base_name] = seen_counts.get(base_name, 0) + 1
        occurrence = seen_counts[base_name]
        name = base_name if occurrence == 1 else f"{base_name} ({occurrence})"

        attributes.append({"name": name, "proposal": proposal})

    output_path = Path(args.output) if args.output else Path(f"{args.sheet}.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump({"attributes": attributes}, f, indent=2, ensure_ascii=False)

    print(f"Wrote {len(attributes)} attribute(s) to {output_path}")
    if skipped_rows:
        print(f"Skipped {skipped_rows} row(s) with an empty proposal or empty name column(s).")


if __name__ == "__main__":
    main()
