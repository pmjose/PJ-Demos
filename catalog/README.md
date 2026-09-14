# Project Catalog

Browsable, searchable catalog of every GitHub repository on the account, delivered as
a Streamlit app deployed to Snowhouse.

**Live:** [Telco & AI Demo Catalog](https://app.snowflake.com/SFCOGSOPS/snowhouse_aws_us_west_2/#/streamlit-apps/TEMP.PJOSE.PROJECT_CATALOG)
— readable by every Snowflake employee (`SNOWHOUSE_BASIC_RL`).

> **Visibility:** this catalog includes **private** repositories, and the detail pages
> print the access code for gated demos. Both are visible to any signed-in Snowflake
> employee. There is no longer a public front-end: the Next.js export and its GitHub
> Pages site were removed, so nothing here is reachable from the open internet.

## Run it locally

```bash
pip install streamlit
streamlit run streamlit_app.py
```

Everything is read from `data/` and `public/shots/`, so the app needs no Snowflake
connection to run. Features that do need one — the "Most used" sort, view counts, and
the pitch drafter — render nothing at all locally rather than appearing broken.

Streamlit's file watcher polls unless `watchdog` is installed, so **restart the server**
after editing before checking a change in the browser.

## Deploy

```bash
npm run deploy      # snow streamlit deploy --connection Snowhouse --replace
```

Then **re-apply the grant, every time**:

```sql
GRANT USAGE ON STREAMLIT TEMP.PJOSE.PROJECT_CATALOG TO ROLE SNOWHOUSE_BASIC_RL;
```

`--replace` recreates the STREAMLIT object, which silently drops every object-level
grant on it. Nothing errors and the app keeps working for you as its owner, so a
missed grant is invisible until someone else reports they cannot open it. Properties
set in `snowflake.yml` (title, compute pool, runtime) are reapplied automatically;
grants are not.

## Data pipeline

Each step writes a JSON file into `data/` and merges with what is already there, so a
filtered run never drops other demos' results. Run them in any order.

```bash
npm run refresh        # data/repos.json + data/repos/<name>.json from the GitHub API
npm run shots          # public/shots/*.jpg + data/shots.json (screenshots, reachability)
npm run facets         # data/facets.json      industry, market, personas, use cases
npm run tech           # data/tech.json        Snowflake capabilities found in the code
npm run codes          # data/access-codes.json gate codes for demos behind a screen
npm run search-terms   # data/search-terms.json alternative phrasings for search
npm run duplicates     # data/duplicates.json  supersededBy + related demos
```

`refresh` authenticates via `gh auth token`, or `GITHUB_TOKEN` if set. `data/` is
committed, so the app deploys without a token.

`search-terms` and `duplicates` call Cortex AI, and deliberately do so **here rather
than in the app**: `DASHBOARD_SHARING_RL` owns the deployed Streamlit and cannot call
any AI function, so anything at runtime would fail. They run under `SALES_ENGINEER`,
which can. Pass `--enable-templating NONE` to any `snow sql` call carrying demo text —
the CLI otherwise reads `&` as its own variable syntax and fails with a bare
`SQL rendering error`.

Both accept demo names to limit the run, and `derive-tech` / `derive-duplicates` take
`--explain` to show the evidence behind each match.

## What the app shows

Grid of cards with filters for industry, market, persona, use case and Snowflake
capability, all bound to the URL so a filtered view can be shared. Detail pages carry
the business summary, gate code, personas, use cases, detected capabilities, related
demos, and a note when a newer version of a demo exists.

Screenshots come from each demo's own live site. Demos without one get a generated
tile keyed to the repo name.
