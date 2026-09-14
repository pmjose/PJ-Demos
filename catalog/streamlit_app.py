"""Project catalog — Streamlit front-end over the same data/ directory the
Next.js export uses. Runs identically on a laptop and in Streamlit in Snowflake:
all content is read from files shipped alongside the app, so no warehouse,
connection or data grants are needed.
"""

import base64
import html
import io
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, urlencode

import streamlit as st

ROOT = Path(__file__).parent
DATA = ROOT / "data"
SHOTS = ROOT / "public"
CSS = ROOT / "assets" / "app.css"

st.set_page_config(
    page_title="Telco & AI Demo Catalog",
    page_icon=":material/grid_view:",
    layout="wide",
    # The sidebar now carries the access note and the badge legend, so it is worth
    # seeing on arrival rather than behind a toggle.
    initial_sidebar_state="expanded",
)

ALL_INDUSTRIES = "All industries"
ALL_MARKETS = "All markets"
ALL_PERSONAS = "All personas"
ALL_USE_CASES = "All use cases"
ALL_FEATURES = "All capabilities"

SORTS = {
    "Recently updated": (lambda r: r.get("pushedAt") or "", True),
    "Newest": (lambda r: r.get("createdAt") or "", True),
    "Name": (lambda r: r["name"].lower(), False),
    "Industry": (lambda r: ((r.get("industry") or "zz").lower(), r["name"].lower()), False),
    "Market": (lambda r: ((r.get("market") or "zz").lower(), r["name"].lower()), False),
}

CARDS_PER_ROW = 3
PAGE_SIZE = 24
# Every screenshot is 2560x1600, so the thumbnail and the no-preview tile can both be
# pinned to this ratio. That replaces a fixed pixel height, which only lined the two up
# at one particular card width.
CARD_ASPECT = "16 / 10"
# Grid thumbnails are inlined as data URIs, so size matters: at this width they are
# ~10KB each against 135KB for the originals.
THUMB_WIDTH = 440
# The spotlight image is shown far larger, so it gets its own encode.
SPOT_WIDTH = 900
# Gallery thumbnails sit four to a two-thirds-width column, so they are drawn small.
GALLERY_THUMB_WIDTH = 320
# Interior frames a grid card cycles through on hover, on top of its own card image.
# Each frame is inlined as a base64 data URI, so this is a direct multiplier on the
# weight of the grid — the most visited page in the app. Measured per 22-card page:
# 0.29MB with no frames, 0.70MB at these settings, 0.90MB at 320px/q70. Frames are
# deliberately softer than the card image, which stays at THUMB_WIDTH and q78: each one
# is on screen for about a second while the pointer rests, so 260px buys three views
# for the bytes 320px spends on two. Drop CARD_FRAMES to 2 if the grid feels heavy.
CARD_FRAMES = 3
CARD_FRAME_WIDTH = 260
CARD_FRAME_QUALITY = 66
# One slot per frame plus one for the card image itself. Coupled to the pc-frame-cycle
# keyframes in app.css, which hold each frame for a quarter of the cycle: change
# CARD_FRAMES and those percentages have to change with it.
CARD_SLOT_MS = 1200
CARD_CYCLE_MS = CARD_SLOT_MS * (CARD_FRAMES + 1)
# The demo pinned to the spotlight. Set to None to rotate through every eligible demo
# by date instead. A name that no longer exists falls back to that rotation.
SPOTLIGHT_PIN = "SnowTelco-Live-Customer-Intelligence"
HEADLINE_LIMIT = 95
AUDIENCE_LIMIT = 72

OWNER = "Pedro Jose · Snowflake"
OWNER_EMAIL = "pedro.jose@snowflake.com"
GITHUB_PROFILE = "https://github.com/pmjose"
# Says why access has to be asked for and what the answer will be. Deliberately does
# not say "email me": the button directly beneath it already carries the mechanism, and
# the note restating it was three lines spent on what one label already said.
ACCESS_NOTE = (
    "Almost every repo here is private — happy to add you, and to walk you "
    "through any of them."
)
ACCESS_MAILTO = f"mailto:{OWNER_EMAIL}?subject={quote('Repo access request')}"
# A prefilled body so requests arrive with the three things needed to act on them,
# rather than as a message that needs two rounds of clarification.
REQUEST_MAILTO = "mailto:{}?subject={}&body={}".format(
    OWNER_EMAIL,
    quote("Demo request"),
    quote(
        "Customer or industry:\n"
        "What you need to show:\n"
        "When you need it by:\n"
    ),
)
TITLE = "Telco & AI Demo Catalog"
# Deliberately does not claim telco only: the catalog spans 18 industries. What it
# does say is how to get through it, which is the one thing a first-time reader needs.
TAGLINE = (
    "Customer-facing Snowflake demos — browse by industry, market, persona, "
    "use case or capability."
)

# Sort option that only exists where the view log is reachable.
MOST_USED = "Most used"
# Must match the identifier in snowflake.yml — the app's own schema.
VIEWS_TABLE = "TEMP.PJOSE.CATALOG_VIEWS"
SEARCHES_TABLE = "TEMP.PJOSE.CATALOG_SEARCHES"
# Also from snowflake.yml, and used to build shareable deep links into this app.
APP_FQN = "TEMP.PJOSE.PROJECT_CATALOG"
# Owned by SALES_ENGINEER, not the app's role: creating a search service needs Cortex
# embedding rights that DASHBOARD_SHARING_RL lacks. Search services run with owner's
# rights, so the app queries it holding only USAGE.
SEARCH_SERVICE = "TEMP.PJOSE.CATALOG_SEARCH"
# Cheapest model, used only to test whether Cortex is callable at all.
PROBE_MODEL = "llama3.1-8b"
# Drafting prose for a customer, so the strongest writer available here.
PITCH_MODEL = "claude-4-sonnet"

# Repos that exist on the account but are not demos, so never belong in the catalog.
EXCLUDED = {
    "PJ",
    "xoople",
    "TELCO-REVENUE",
    "test",
    "SnowImpact_backup",
    "CMU-AI",
    "snowflake",
    "Snowtch",
    "Flurry",
}


def in_catalog(repo):
    """Forks are other people's projects; EXCLUDED names are not demos."""
    return not repo.get("isFork") and repo.get("name") not in EXCLUDED


# ---------------------------------------------------------------- data loading

def stamp(path):
    """Modification time, passed into the cached readers below as a cache key.
    Without it @st.cache_data never notices an edited data file, because the
    function's code and arguments are unchanged — stale until the process restarts.

    The readers name this parameter `stamp_ns` rather than `_stamp` on purpose:
    Streamlit deliberately excludes underscore-prefixed arguments from the cache key, so
    an underscore here passes the mtime in and then ignores it, which silently restores
    exactly the staleness this is meant to prevent."""
    return path.stat().st_mtime_ns if path.exists() else 0


@st.cache_data(show_spinner=False)
def read_json(path_str, stamp_ns):
    path = Path(path_str)
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


@st.cache_data(show_spinner=False)
def read_text(path_str, stamp_ns):
    path = Path(path_str)
    return path.read_text(encoding="utf-8") if path.exists() else ""


def raw_html(body):
    """Emit HTML untouched by the markdown pipeline.

    st.html skips markdown entirely, which matters for nested block elements; the
    fallback exists because the app cannot check which Streamlit version the Snowflake
    container runtime runs.
    """
    if hasattr(st, "html"):
        st.html(body)
    else:
        st.markdown(body, unsafe_allow_html=True)


def inject_css():
    """Load the stylesheet, then the progress element.

    The stylesheet goes through st.markdown rather than raw_html, which is the one place
    in this file that deliberately bypasses st.html. Both st.html routes were observed
    losing the stylesheet, and in each case the server had enqueued all 28KB correctly, so
    nothing on the Python side showed a problem — every custom class in the app simply
    rendered unstyled with no error anywhere:

      - Style tag and progress div in one string. This is mixed content, so it takes the
        main-container path. It rendered correctly most of the time and then served a
        wholly unstyled page from a clean process, which is the worst of the three
        behaviours: intermittent, silent, and not reproducible on demand. The mechanism
        was never pinned down, so treat the cause as unknown rather than as sanitising.
      - A style-only string. Streamlit routes that to the event container, and on this
        version that emitted no DOM node at all — no style tag, no element, nothing to
        find. This one is consistent, and consistently wrong.

    st.markdown with unsafe_allow_html puts the tag in the main container and keeps it,
    which is the arrangement this app has verified. The cost is an empty wrapper element;
    it draws nothing but still spends a flex gap, which the stylesheet accounts for.

    Absent stylesheet still means no styling rather than a broken page, but that is a thin
    guarantee now that the sheet carries layout and not only motion.
    """
    css = read_text(str(CSS), stamp(CSS))
    if not css:
        return
    st.markdown(f"<style>{css}</style>", unsafe_allow_html=True)
    # The progress bar carries no styling of its own, so where scroll-driven animation
    # is unsupported the @supports guard leaves it an inert empty element.
    raw_html('<div class="pc-progress"></div>')


def load_facets():
    """Canonical industry, market, personas and use cases per demo."""
    path = DATA / "facets.json"
    return read_json(str(path), stamp(path)) or {}


def load_tech():
    """Snowflake capabilities detected in each demo's own code, from derive-tech.mjs."""
    path = DATA / "tech.json"
    return read_json(str(path), stamp(path)) or {}


def load_search_terms():
    """Alternative phrasings per demo from derive-search-terms.mjs. Index-only: these
    feed the haystack and are never displayed, since they are inferred rather than
    stated and would read as unearned claims on the page."""
    path = DATA / "search-terms.json"
    return read_json(str(path), stamp(path)) or {}


def load_duplicates():
    """Supersession and related-demo links from derive-duplicates.mjs."""
    path = DATA / "duplicates.json"
    return read_json(str(path), stamp(path)) or {}


def load_index():
    path = DATA / "repos.json"
    index = dict(read_json(str(path), stamp(path)) or {"repos": []})
    facets = load_facets()
    tech = load_tech()
    shots = load_shots()
    terms = load_search_terms()
    dupes = load_duplicates()
    repos = []
    for repo in index.get("repos", []):
        if not in_catalog(repo):
            continue
        repo = dict(repo)
        facet = facets.get(repo["name"]) or {}
        # The canonical industry replaces the raw label, which had ~28 variants.
        repo["industry"] = facet.get("industry") or repo.get("industry")
        repo["market"] = facet.get("market")
        repo["personas"] = facet.get("personas") or []
        repo["alsoFor"] = facet.get("alsoFor") or []
        repo["useCases"] = facet.get("useCases") or []
        repo["features"] = tech.get(repo["name"]) or []
        repo["searchTerms"] = terms.get(repo["name"]) or []
        # Superseded demos stay in the grid: clustering has false positives, and
        # wrongly hiding one is worse than a note the reader can ignore.
        repo["supersededBy"] = (dupes.get(repo["name"]) or {}).get("supersededBy")
        # Reachability lives only in shots.json, not the index. Stays None unless a
        # check actually ran, so "unknown" is never mistaken for "broken".
        health = shots.get(repo["name"]) or {}
        repo["siteOk"] = health.get("ok")
        repo["siteStatus"] = health.get("status")
        repos.append(repo)
    index["repos"] = repos
    return index


def load_repo(name):
    path = DATA / "repos" / f"{name}.json"
    return read_json(str(path), stamp(path))


def load_codes():
    """Gate codes for the demos that sit behind an access screen."""
    path = DATA / "access-codes.json"
    return read_json(str(path), stamp(path)) or {}


def load_shots():
    """Screenshot metadata, which is also the only record of whether each live site
    actually responded when it was last checked."""
    path = DATA / "shots.json"
    return read_json(str(path), stamp(path)) or {}


# --------------------------------------------------------------------- helpers

def repo_url(repo):
    """Index records carry `nameWithOwner` rather than a full URL, unlike the
    per-repo detail files."""
    owner = repo.get("nameWithOwner")
    return f"https://github.com/{owner}" if owner else None


def shot_path(rel):
    """Absolute path to a screenshot, or None when the file was not shipped."""
    if not rel:
        return None
    path = SHOTS / rel
    return path if path.exists() else None


def fmt_date(iso):
    if not iso:
        return "—"
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).strftime("%-d %b %Y")
    except ValueError:
        return iso


def lead_lower(text):
    """Lowercase the leading word so it reads mid-sentence, unless it is an
    acronym — 'SUTEL executives' and 'CFOs' must keep their capitals."""
    if not text:
        return text
    head = text.split(" ", 1)[0]
    if sum(1 for ch in head if ch.isupper()) >= 2:
        return text
    return text[0].lower() + text[1:]


def clamp(text, limit):
    """Cap length so card text cannot swing card heights wildly."""
    if not text or len(text) <= limit:
        return text
    return text[: limit - 1].rstrip(" ,.;:") + "…"


@st.cache_data(show_spinner=False)
def thumb_uri(path_str, stamp_ns, width=THUMB_WIDTH, quality=78):
    """A small JPEG of a screenshot, inlined as a data URI.

    Inlined rather than rendered with st.image because that hardcodes
    target="_blank" on its link, which inside Snowsight would open the bare app URL
    outside its wrapper. Owning the markup is the only way to keep the click in place.
    Pillow ships with Streamlit, so this adds no dependency, and the cache key includes
    the file's mtime so a re-shot screenshot is picked up.
    """
    from PIL import Image

    with Image.open(path_str) as im:
        im.thumbnail((width, width))
        buf = io.BytesIO()
        im.convert("RGB").save(buf, "JPEG", quality=quality, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


@st.cache_data(show_spinner=False)
def thumb_bytes(path_str, stamp_ns, width=GALLERY_THUMB_WIDTH):
    """A downscaled JPEG of a screenshot, as bytes.

    The gallery captures are 1280px wide so that opening one full size is worth doing.
    Handing those straight to a thumbnail slot would ship roughly 400KB per detail page
    view for images drawn at a fifth of that size, so they are resized here and cached
    on mtime exactly like the card thumbnails. Bytes rather than a data URI because
    st.image is fine here: these thumbnails are buttons, not links, so nothing needs to
    be wrapped in markup this app controls.
    """
    from PIL import Image

    with Image.open(path_str) as im:
        im.thumbnail((width, width))
        buf = io.BytesIO()
        im.convert("RGB").save(buf, "JPEG", quality=78, optimize=True)
    return buf.getvalue()


def lightbox(label, path, url):
    """One screenshot, full size, over the page.

    Built here rather than decorated at module level because the title is the view's own
    name. st.dialog is checked for rather than assumed because the app cannot know which
    Streamlit version the Snowflake container runtime is on; without it the image opens
    inline, which is worse but not broken.
    """

    def body():
        st.image(str(path), width="stretch")
        if url:
            st.link_button(
                "Open this view in the live demo", url, icon=":material/open_in_new:"
            )

    if hasattr(st, "dialog"):
        st.dialog(label, width="large")(body)()
    else:
        with st.expander(label, expanded=True):
            body()


def render_gallery(name, gallery):
    """Thumbnails of the demo's interior, each opening full size.

    Additive by design: the card image in the grid stays the gate screen, because that is
    what a visitor actually meets when they open the link. This row is the answer to
    "what is behind it", which for 51 of 53 live demos the catalog could not previously
    show at all.

    The row is built from whatever the capture script recorded rather than a fixed four,
    so a demo that yielded three views does not leave a hole.
    """
    views = [(view, shot_path(view.get("file"))) for view in gallery]
    views = [(view, path) for view, path in views if path]
    if not views:
        return

    st.caption("Inside the demo — click a view to open it full size")
    for column, (view, path) in zip(st.columns(len(views)), views):
        with column:
            st.image(thumb_bytes(str(path), stamp(path)), width="stretch")
            label = view.get("label") or "View"
            if st.button(
                clamp(label, 24),
                key=f"gallery_{name}_{path.name}",
                help=f"{label} — open full size",
            ):
                lightbox(label, path, view.get("url"))


# Shared by the thumbnail and the no-preview tile so mixed rows always align. The
# pc-card-face class is on both so the card-level rules — hover lift, entrance — apply
# whether or not a demo has a screenshot; keying those off pc-media alone left every
# placeholder card inert, which on page 3 is two thirds of them.
BOX = f"width:100%;aspect-ratio:{CARD_ASPECT};border-radius:8px;display:block"
# Inline rather than in the stylesheet: opacity reads an inherited custom property
# the stylesheet sets on hover, so with no stylesheet at all the scrim stays hidden
# instead of leaving a stray call to action under every card.
SCRIM = (
    "position:absolute;inset:auto 0 0 0;display:flex;justify-content:flex-end;"
    "padding:.5rem .6rem;pointer-events:none;opacity:var(--pc-scrim-o,0);"
    "background:linear-gradient(to top,rgba(10,22,33,.72),rgba(10,22,33,0))"
)


def card_frames(name):
    """Interior frames for a card's hover preview, as data URIs.

    Empty for a demo with no gallery, which leaves its card markup exactly as it was.
    The card image itself is the gate screen for most demos, so these frames are the
    only place the grid shows what the demo actually does.
    """
    gallery = (load_shots().get(name) or {}).get("gallery") or []
    uris = []
    for view in gallery[:CARD_FRAMES]:
        path = shot_path(view.get("file"))
        if path:
            uris.append(
                thumb_uri(str(path), stamp(path), CARD_FRAME_WIDTH, CARD_FRAME_QUALITY)
            )
    return uris


# Overlay frames fill the card and start invisible. Both facts are inline rather than in
# the stylesheet for the same reason the scrim's opacity is: with no stylesheet at all
# the frames stay hidden and the card looks exactly as it did before, instead of
# stacking four screenshots on top of each other.
FRAME_BOX = (
    "position:absolute;inset:0;width:100%;height:100%;border-radius:8px;"
    "object-fit:cover;object-position:top center;opacity:0"
)


def card_thumb(repo, shot):
    """The screenshot, clickable through to the demo's detail view.

    Layout stays inline and only motion comes from the stylesheet, so a build that
    ships without assets/app.css looks exactly as it did before rather than breaking.
    """
    frames = "".join(
        f'<img class="pc-shot pc-frame" src="{uri}" alt="" aria-hidden="true"'
        f' style="{FRAME_BOX};animation-delay:{(i + 1) * CARD_SLOT_MS}ms">'
        for i, uri in enumerate(card_frames(repo["name"]))
    )
    st.markdown(
        f"""<a class="pc-card-face pc-media" href="{html.escape(detail_link(repo['name']))}"
        target="_self" style="{BOX};text-decoration:none;--pc-cycle:{CARD_CYCLE_MS}ms"
        ><img class="pc-shot" src="{thumb_uri(str(shot), stamp(shot))}"
              alt="Screenshot of the {html.escape(repo['name'])} demo"
              style="{BOX};object-fit:cover;object-position:top center"
        >{frames}<span class="pc-scrim" style="{SCRIM}"
        ><span class="pc-cta">View details →</span></span></a>""",
        unsafe_allow_html=True,
    )


def tile(repo):
    """Stand-in for demos with no screenshot, keyed to the name so a project always gets
    the same colour. Deliberately carries no industry or repo name, since both already
    appear directly below it. Clickable like a real screenshot, and on the same aspect
    ratio so mixed rows stay aligned.

    The anchor is the box itself rather than wrapping a <div>: markdown cannot keep a
    block element inside an inline <a>, so a wrapped div gets reparented out, which left
    all but the text unclickable and pushed the tile down by the leftover empty tag.

    The gradient sits on an oversized inner layer the stylesheet drifts, so "no
    screenshot" reads as deliberate rather than as a gap. Text lightness is 26%, which
    clears WCAG AA against both gradient stops for every one of the 360 hues; 34% did
    not, bottoming out at 3.69:1.
    """
    h = 0
    for ch in repo["name"]:
        h = (h * 31 + ord(ch)) % 360
    light, dark = f"hsl({h} 42% 90%)", f"hsl({(h + 40) % 360} 38% 84%)"
    st.markdown(
        f"""<a class="pc-card-face pc-tile" href="{html.escape(detail_link(repo['name']))}"
        target="_self" style="{BOX};display:flex;align-items:center;
        justify-content:center;text-decoration:none;background:{light}"
        ><span class="pc-wash" style="position:absolute;inset:-25%;display:block;
        background:linear-gradient(135deg,{light},{dark})"></span
        ><span style="position:relative;font-size:.72rem;letter-spacing:.07em;
        text-transform:uppercase;color:hsl({h} 28% 26%)">No live site</span></a>""",
        unsafe_allow_html=True,
    )


# ------------------------------------------------------------------ navigation

def open_repo(name):
    st.query_params["repo"] = name


def detail_link(name):
    """Relative URL that opens a demo's detail view.

    Every current parameter is carried over except `repo`, so arriving by clicking a
    screenshot lands in the same filtered set as the button would — otherwise prev/next
    on the detail page would silently escape the filters the reader had applied.
    """
    params = [(k, v) for k, v in st.query_params.items() if k != "repo"]
    params.append(("repo", name))
    return "?" + urlencode(params)


def close_repo():
    # Delete only `repo`: clearing everything would wipe the bound filter params
    # (and raise, since bound params cannot be removed via st.query_params).
    if "repo" in st.query_params:
        del st.query_params["repo"]


# ------------------------------------------------- Snowflake-only capabilities
# Everything here degrades to nothing when no Snowflake session exists, which is
# the case both under a local `streamlit run` and on the GitHub Pages export.
# Unavailable features render no UI at all rather than a disabled control, so the
# two front-ends never advertise something one of them cannot do.

@st.cache_resource(show_spinner=False)
def session():
    """The active Snowflake session, or None when running outside Snowflake.
    cache_resource rather than cache_data: a session is a live connection, not a
    value, and must not be copied per caller."""
    try:
        from snowflake.snowpark.context import get_active_session

        return get_active_session()
    except Exception:
        return None


def viewer():
    """Who is looking, when that is knowable. Owner's-rights sessions report the
    owner for CURRENT_USER(), so the Streamlit-supplied identity is tried first and
    SQL fills in whatever it can if this returns None."""
    try:
        return getattr(st.user, "email", None) or None
    except Exception:
        return None


@st.cache_data(show_spinner=False)
def app_url():
    """This app's Snowsight address, so a link to it can be handed to someone else.

    The app cannot read its own URL. It renders inside a cross-origin iframe, so
    window.location belongs to the *.aws.snowflake.app frame and is useless as
    something to share; org and account come from SQL instead. APP_FQN has to track
    the identifier in snowflake.yml — rename the app there and this link silently
    points at the old name. None outside Snowflake, where there is no link to offer.
    """
    if session() is None:
        return None
    try:
        row = (
            session()
            .sql("SELECT CURRENT_ORGANIZATION_NAME() AS ORG, CURRENT_ACCOUNT_NAME() AS ACCT")
            .collect()[0]
        )
        return (
            f"https://app.snowflake.com/{row['ORG'].lower()}/{row['ACCT'].lower()}"
            f"/#/streamlit-apps/{APP_FQN}"
        )
    except Exception:
        return None


def share_link(**params):
    """A deep link into this app.

    Streamlit in Snowflake prefixes every query parameter with `streamlit-` in the
    browser URL, and strips that prefix again before st.query_params sees it. So the
    keys used here are the same ones read elsewhere in this file, with the prefix
    added on the way out.
    """
    base = app_url()
    if not base:
        return None
    query = urlencode({f"streamlit-{k}": v for k, v in params.items() if v})
    return f"{base}?{query}" if query else base


def render_share(label, blurb, **params):
    """A copy-able deep link, or nothing at all when there is no link to give.

    st.code carries its own copy button, which is why the URL is rendered as code
    rather than as a link: the useful action here is copying it into Slack, not
    following it. Tucked inside a popover because the URLs are long enough to
    dominate the layout otherwise.
    """
    url = share_link(**params)
    if not url:
        return
    with st.popover(label, icon=":material/link:"):
        st.caption(blurb)
        st.code(url, language=None, wrap_lines=True)


def log_view(name):
    """Record a detail-page open. Fire-and-forget by design: telemetry failing must
    never break a render, so every error is swallowed."""
    if session() is None:
        return
    # Any widget interaction reruns the script; only a change of demo is a new view.
    if st.session_state.get("_logged_view") == name:
        return
    st.session_state["_logged_view"] = name
    try:
        session().sql(
            f"INSERT INTO {VIEWS_TABLE} (REPO_NAME, VIEWER, SOURCE) "
            "SELECT ?, COALESCE(?, CURRENT_USER()), ?",
            params=[name, viewer(), "streamlit"],
        ).collect()
    except Exception:
        pass


@st.cache_data(ttl=300, show_spinner=False)
def view_counts():
    """Opens per demo. Cached for five minutes because this is a warehouse query and
    the grid re-runs on every keystroke in the search box."""
    if session() is None:
        return {}
    try:
        rows = session().sql(
            f"SELECT REPO_NAME AS name, COUNT(*) AS n FROM {VIEWS_TABLE} GROUP BY 1"
        ).collect()
        return {r["NAME"]: int(r["N"]) for r in rows}
    except Exception:
        return {}


@st.cache_resource(show_spinner=False)
def search_available():
    """Whether the Cortex Search service can be queried. Probed once per process, so
    the semantic toggle never appears where it would fail."""
    if session() is None:
        return False
    try:
        session().sql(
            "SELECT SNOWFLAKE.CORTEX.SEARCH_PREVIEW(?, ?) AS p",
            params=[SEARCH_SERVICE, json.dumps({"query": "test", "columns": ["NAME"],
                                                "limit": 1})],
        ).collect()
        return True
    except Exception:
        return False


@st.cache_data(ttl=600, show_spinner=False)
def semantic_order(query):
    """Demo names ranked by relevance, or None if the service could not answer.

    Only NAME is requested and the limit covers the whole catalog: there are 91 demos,
    so asking for the complete ranking and applying the facets locally is both exact
    and cheaper than pushing filters into the service. It also keeps persona, use case
    and capability working — none of them is an indexed attribute.
    """
    if not query or session() is None:
        return None
    try:
        payload = json.dumps({"query": query, "columns": ["NAME"], "limit": 200})
        raw = session().sql(
            "SELECT SNOWFLAKE.CORTEX.SEARCH_PREVIEW(?, ?) AS p",
            params=[SEARCH_SERVICE, payload],
        ).collect()[0]["P"]
        results = json.loads(raw).get("results") or []
        return [r["NAME"] for r in results if r.get("NAME")]
    except Exception:
        return None


def log_search(query, result_count, mode, filtered):
    """Record a committed search and what it returned. Fire-and-forget, like log_view.

    The count is the one the user actually saw, after every facet, and `filtered` is
    carried alongside so a zero-result row can be read as "no such demo" rather than
    "over-filtered" without guessing.
    """
    if session() is None or not query:
        return
    # The search box commits on Enter or blur, but any other widget still reruns the
    # script; without this each rerun would log the same search again.
    fingerprint = (query, mode, result_count, filtered)
    if st.session_state.get("_logged_search") == fingerprint:
        return
    st.session_state["_logged_search"] = fingerprint
    try:
        session().sql(
            f"INSERT INTO {SEARCHES_TABLE} (QUERY, RESULT_COUNT, MODE, FILTERED, SOURCE) "
            "SELECT ?, ?, ?, ?, ?",
            params=[query[:500], int(result_count), mode, bool(filtered), "streamlit"],
        ).collect()
    except Exception:
        pass


def sort_options():
    """Streamlit falls back to the first option when a bound URL value is missing
    from the list, so a shared ?sort=Most+used link degrades quietly off-Snowflake
    instead of erroring."""
    return list(SORTS) + ([MOST_USED] if session() is not None else [])


@st.cache_resource(show_spinner=False)
def ai_available():
    """Whether this session's role can call Cortex at all.

    DASHBOARD_SHARING_RL, which owns the deployed app, currently cannot: the missing
    grant is `USE AI FUNCTIONS ON ACCOUNT`. So this returns False in Snowhouse today
    and anything gated on it stays hidden. It is probed rather than hard-coded so
    the feature appears by itself once the grant lands, with no redeploy.

    A real call is unavoidable. The obvious zero-cost probe — referencing the
    function under `WHERE 1=0` — reports success for a role that has no access,
    because the expression is pruned before privileges are resolved.
    """
    if session() is None:
        return False
    try:
        session().sql(f"SELECT AI_COMPLETE('{PROBE_MODEL}', 'ok') AS p").collect()
        return True
    except Exception:
        return False


# ------------------------------------------------------------------ pdf export

# A4 at 150dpi. Big enough that the screenshots hold up in print, small enough that a
# ten-demo pack stays around a megabyte.
PAGE = (1240, 1754)
MARGIN = 70
INK = (21, 32, 43)
MUTED = (91, 103, 115)
RULE = (227, 232, 238)
# The footer owns the bottom of the page, so body text has to stop above it. Without
# this the prose ran straight through the rule and printed on top of the URL line.
FOOTER_H = 60
BODY_LIMIT = PAGE[1] - MARGIN - FOOTER_H
# Deliberately small: a hero at 430px plus two rows of 260px screenshots consumed 1200
# of the 1614 usable pixels and left no room for the prose that justifies the demo.
HERO_H = 300
CELL_H = 190
# Most demos list four or five of each; the fifth is always the weakest and it is the
# one that pushes the page over.
MAX_BULLETS = 4


def pdf_font(size, bold=False):
    """A scalable font, identically on a laptop and in the container.

    The first rung is a font shipped in assets/fonts, and it is the only rung that is
    actually guaranteed: the container image is not documented to carry any font file,
    and the difference is not subtle — Pillow's built-in fallback is a fixed bitmap face
    that ignores the requested size, so a page set in it comes out crude and tiny. Nor
    can it be checked after the fact, because the deployed app renders in a cross-origin
    frame that automated checks can read but not drive. Shipping the font removes the
    question instead of leaving it to the image.

    DejaVu Sans, from matplotlib's copy, under the permissive DejaVu licence. It also
    covers the accents these demos need — Spanish, Portuguese, Turkish.

    The system paths stay as a safety net for a build that ships without assets, and
    load_default(size=...) last, which only gained its size argument in Pillow 10.1.
    """
    from PIL import ImageFont

    face = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    for path in (
        ROOT / "assets" / "fonts" / face,
        "/usr/share/fonts/truetype/dejavu/DejaVuSans%s.ttf" % ("-Bold" if bold else ""),
        "/usr/share/fonts/dejavu/DejaVuSans%s.ttf" % ("-Bold" if bold else ""),
        "/System/Library/Fonts/Supplemental/Arial%s.ttf" % (" Bold" if bold else ""),
    ):
        try:
            return ImageFont.truetype(str(path), size)
        except Exception:
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def wrap(draw, text, font, width):
    """Greedy word wrap against measured pixel width.

    textbbox rather than a character count, because the fonts above differ in width by
    more than a third and a count tuned for one overflows the others.
    """
    words, lines, line = (text or "").split(), [], ""
    for word in words:
        trial = f"{line} {word}".strip()
        if draw.textbbox((0, 0), trial, font=font)[2] <= width or not line:
            line = trial
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def draw_block(draw, xy, text, font, width, fill=INK, leading=1.4, limit=None):
    """Wrapped text, returning the y coordinate just past what was drawn.

    `limit` stops mid-paragraph rather than letting a long block run into the footer,
    which is what happened before: the prose overprinted the URL line.
    """
    x, y = xy
    step = int(font.size * leading) if hasattr(font, "size") else 16
    for line in wrap(draw, text, font, width):
        if limit is not None and y > limit:
            return y
        draw.text((x, y), line, font=font, fill=fill)
        y += step
    return y


def banner(path, width, height):
    """A screenshot cropped to a fixed band rather than fitted inside one.

    Fitting left a 300px-tall hero only 466px wide on a 1100px page, so the page read as
    a narrow column of images against a field of white. Cropping keeps the full width and
    takes it off the top, which is the part that identifies the page — the same reason the
    grid cards use object-position: top center.
    """
    from PIL import Image

    with Image.open(path) as im:
        shot = im.convert("RGB")
        scaled = shot.resize(
            (width, max(1, round(shot.height * width / shot.width))), Image.LANCZOS
        )
    return scaled.crop((0, 0, width, min(height, scaled.height)))


def pdf_page(entry, business, gallery):
    """One demo, one page: what it is, what it shows, and what it is worth.

    `entry` is the index record rather than the detail file, because market, shot and
    siteUrl only exist in that shape — load_index enriches entries with facets, while the
    detail file nests its screenshot and link under `site`. Reading the wrong one of the
    two silently drops the hero image and the live link.

    Laid out top down with the y cursor carried between sections, because every block is
    variable height — a four-bullet business_value and a one-bullet one cannot share a
    fixed grid.
    """
    from PIL import Image, ImageDraw

    page = Image.new("RGB", PAGE, "white")
    draw = ImageDraw.Draw(page)
    inner = PAGE[0] - 2 * MARGIN
    name = entry["name"]
    y = MARGIN

    y = draw_block(
        draw, (MARGIN, y), business.get("headline") or name, pdf_font(34, bold=True), inner
    )
    context = " · ".join(
        v
        for v in (
            business.get("industry") or entry.get("industry"),
            entry.get("market"),
            name,
        )
        if v
    )
    y = draw_block(draw, (MARGIN, y + 6), context, pdf_font(19), inner, fill=MUTED) + 10
    draw.line((MARGIN, y, PAGE[0] - MARGIN, y), fill=RULE, width=2)
    y += 24

    hero = shot_path(entry.get("shot"))
    if hero:
        shot = banner(hero, inner, HERO_H)
        page.paste(shot, (MARGIN, y))
        y += shot.height + 22

    # The interior views, two up. These are the whole reason the pack is worth printing:
    # for a gated demo the hero above is the access screen, so without them the page
    # shows a password box and nothing else.
    if gallery:
        cell = (inner - 20) // 2
        label_font = pdf_font(15)
        row_top = y
        for i, view in enumerate(gallery[:4]):
            path = shot_path(view.get("file"))
            if not path:
                continue
            frame = banner(path, cell, CELL_H)
            col, row = i % 2, i // 2
            fx = MARGIN + col * (cell + 20)
            fy = row_top + row * (frame.height + 38)
            page.paste(frame, (fx, fy))
            draw.text(
                (fx, fy + frame.height + 5),
                clamp(view.get("label") or f"View {i + 1}", 40),
                font=label_font,
                fill=MUTED,
            )
            y = max(y, fy + frame.height + 26)
        y += 18

    body, head = pdf_font(16), pdf_font(19, bold=True)
    for title, value in (
        ("The business problem", business.get("business_problem")),
        ("What this demo shows", business.get("solution")),
    ):
        if not value or y > BODY_LIMIT:
            continue
        y = draw_block(draw, (MARGIN, y), title, head, inner) + 2
        y = draw_block(draw, (MARGIN, y), value, body, inner, limit=BODY_LIMIT) + 14

    for title, items in (
        ("Business value", business.get("business_value")),
        ("Key capabilities", business.get("key_capabilities")),
    ):
        if not items or y > BODY_LIMIT:
            continue
        y = draw_block(draw, (MARGIN, y), title, head, inner) + 2
        for item in items[:MAX_BULLETS]:
            if y > BODY_LIMIT:
                break
            y = draw_block(
                draw, (MARGIN + 18, y), f"— {item}", body, inner - 18, limit=BODY_LIMIT
            ) + 3
        y += 10

    # Footer: the link and, when there is one, the code. A pack whose demos cannot be
    # opened is worth nothing to the person holding it.
    foot = PAGE[1] - MARGIN
    draw.line((MARGIN, foot - 46, PAGE[0] - MARGIN, foot - 46), fill=RULE, width=2)
    parts = [p for p in (entry.get("siteUrl"), repo_url(entry)) if p]
    code = load_codes().get(name)
    if code:
        parts.append(f"access code {code}")
    draw.text((MARGIN, foot - 32), "  ·  ".join(parts), font=pdf_font(15), fill=MUTED)
    return page


@st.cache_data(show_spinner=False)
def pdf_pack(names, stamp_ns):
    """The shortlist as a multi-page PDF.

    Pillow writes it, which is why there is no PDF library in the dependencies: adding
    one would mean a pyproject.toml and therefore PyPI resolution through an external
    access integration, for a page this simple.

    stamp_ns is a cache key, not a parameter — and it is spelled without a leading
    underscore on purpose, since Streamlit drops underscore-prefixed arguments from the
    key and would make a re-shot screenshot invisible here.
    """
    from PIL import Image  # noqa: F401  (ensures a clear error here, not mid-compose)

    pages = []
    skipped = []
    by_name = {r["name"]: r for r in load_index()["repos"]}
    for name in names:
        entry = by_name.get(name)
        detail = load_repo(name)
        if entry is None or detail is None:
            continue
        business = detail.get("business") or {}
        # Nothing to print: no description was derivable from the repo, so a page would
        # be a headline over white space.
        if business.get("evidence_grade") == "insufficient" or not business.get("headline"):
            skipped.append(name)
            continue
        gallery = (load_shots().get(name) or {}).get("gallery") or []
        pages.append(pdf_page(entry, business, gallery))
    if not pages:
        return None, skipped
    buf = io.BytesIO()
    pages[0].save(
        buf, "PDF", save_all=True, append_images=pages[1:], resolution=150.0
    )
    return buf.getvalue(), skipped


# ------------------------------------------------------------------- shortlist

def picks():
    """Shortlisted demo names. Held in the URL rather than session state so a
    selection can be pasted to someone else, and survives the round trip into a
    detail page and back."""
    return [n for n in (st.query_params.get("picks") or "").split(",") if n]


def toggle_pick(name):
    chosen = picks()
    if name in chosen:
        chosen.remove(name)
        st.toast(f"Removed {name} from your shortlist", icon=":material/remove:")
    else:
        chosen.append(name)
        st.toast(f"Saved {name} to your shortlist", icon=":material/bookmark_added:")
    if chosen:
        st.query_params["picks"] = ",".join(chosen)
    else:
        clear_picks()


def clear_picks():
    # `picks` is not a bound widget param, so unlike the filters it can be deleted.
    if "picks" in st.query_params:
        del st.query_params["picks"]


def pick_button(repo, key, compact=False):
    saved = repo["name"] in picks()
    st.button(
        ("Saved" if saved else "Save") if compact
        else ("In shortlist" if saved else "Add to shortlist"),
        key=key,
        icon=":material/bookmark_added:" if saved else ":material/bookmark_add:",
        help="Remove from your shortlist" if saved else "Add to your shortlist",
        on_click=toggle_pick,
        args=(repo["name"],),
    )


def shortlist_markdown(names):
    """The shortlist as something you can paste into Slack or an email — headline,
    where it applies, the links, and the gate code if there is one."""
    by_name = {r["name"]: r for r in load_index()["repos"]}
    codes = load_codes()
    lines = []
    for name in names:
        repo = by_name.get(name)
        if not repo:
            continue
        line = f"- **{repo.get('headline') or name}**"
        context = [v for v in (repo.get("industry"), repo.get("market")) if v]
        if context:
            line += f" ({' · '.join(context)})"
        links = []
        if repo.get("siteUrl"):
            links.append(f"[Live demo]({repo['siteUrl']})")
        source = repo_url(repo)
        if source:
            links.append(f"[Source]({source})")
        if links:
            line += " — " + " · ".join(links)
        if codes.get(name):
            line += f" — access code `{codes[name]}`"
        lines.append(line)
    return "\n".join(lines)


def render_shortlist(repos):
    """Only rendered when something is shortlisted, so it costs no space otherwise."""
    known = {r["name"] for r in repos}
    # A pasted URL can name demos that have since left the catalog.
    chosen = [n for n in picks() if n in known]
    if not chosen:
        return
    with st.expander(
        f"Shortlist · {len(chosen)} demo{'' if len(chosen) == 1 else 's'}",
        icon=":material/bookmark:",
        # Every save is a rerun, and a collapsed default meant the panel snapped
        # shut each time you added to it.
        expanded=True,
    ):
        body = shortlist_markdown(chosen)
        st.markdown(body)
        st.caption(
            "Copy the block below to paste elsewhere. The shortlist is held in this "
            "page's URL, so sharing the address bar link shares the selection too."
        )
        # Wrapped: these lines run to ~1900px and were otherwise clipped, so the
        # text could not be read without scrolling sideways.
        st.code(body, language="markdown", wrap_lines=True)
        with st.container(horizontal=True, gap="small"):
            st.button("Clear shortlist", icon=":material/clear_all:", on_click=clear_picks)
            render_share(
                "Share this shortlist",
                "Opens the catalog with these demos already selected.",
                picks=",".join(chosen),
            )
            pack_trigger(chosen)
        pack_output(chosen)


@st.cache_data(show_spinner=False)
def pack_preview(name, stamp_ns):
    """Page one as a PNG, so what the pack will look like is visible before download.

    Also the only way to see which rung of pdf_font's ladder the container took: a page
    set in the bitmap fallback is obvious on sight and invisible in the byte count.
    """
    from PIL import Image

    entry = {r["name"]: r for r in load_index()["repos"]}.get(name)
    detail = load_repo(name)
    if entry is None or detail is None:
        return None
    page = pdf_page(
        entry,
        detail.get("business") or {},
        (load_shots().get(name) or {}).get("gallery") or [],
    )
    # Matched to the width the expander actually gives it. Rendered at 620 the browser
    # upscaled it 2.5x and every screenshot in the preview looked soft, which reads as a
    # fault in the pack rather than in the preview. JPEG because Streamlit re-encodes to
    # JPEG on the way out regardless, so a PNG here only costs bytes.
    page = page.resize((980, round(PAGE[1] * 980 / PAGE[0])), Image.LANCZOS)
    buf = io.BytesIO()
    page.save(buf, "JPEG", quality=82, optimize=True)
    return buf.getvalue()


def pack_trigger(chosen):
    """The button that asks for a pack. Separate from pack_output so the trigger can sit
    in the row of actions while the download and preview render full width below it."""
    if st.button(
        "Build a PDF pack",
        icon=":material/picture_as_pdf:",
        help="One printable A4 page per shortlisted demo, with screenshots",
    ):
        st.session_state["_pack"] = ",".join(chosen)


def pack_output(chosen):
    """The shortlist as a printable pack, built on request rather than on every rerun.

    Composing is a second or so per demo, and the shortlist panel re-renders on every
    keystroke in the search box, so this is deliberately two steps: the button records
    what to build, and only a matching selection is composed. Changing the shortlist
    therefore drops the built pack rather than silently offering a download whose
    contents no longer match what is on screen.
    """
    if st.session_state.get("_pack") != ",".join(chosen):
        return

    with st.spinner(f"Composing {len(chosen)} page{'' if len(chosen) == 1 else 's'}…"):
        data, skipped = pdf_pack(tuple(chosen), stamp(DATA / "shots.json"))
    if not data:
        st.info(
            "None of these demos has a written-up business case yet, so there is "
            "nothing to put in a pack.",
            icon=":material/info:",
        )
        return

    built = len(chosen) - len(skipped)
    st.download_button(
        f"Download {built} page{'' if built == 1 else 's'} · {len(data) / 1048576:.1f}MB",
        data=data,
        file_name=f"demo-pack-{built}-demo{'' if built == 1 else 's'}.pdf",
        mime="application/pdf",
        icon=":material/download:",
        type="primary",
    )
    if skipped:
        st.caption(
            "Left out for want of a business write-up: " + ", ".join(skipped) + "."
        )
    # The first demo that made it in, not the first shortlisted: previewing a page that
    # was left out would be showing something the download does not contain.
    first = next((n for n in chosen if n not in skipped), None)
    preview = pack_preview(first, stamp(DATA / "shots.json")) if first else None
    if preview:
        with st.expander("Preview page one", icon=":material/visibility:"):
            st.image(preview, width="stretch")


def filter_value(key, default):
    """A filter's current value, from the widget if it exists and the URL otherwise.

    `bind="query-params"` only syncs into session state while the widget is on screen.
    The detail view renders no filter controls, so session state is empty there and the
    values have to come straight from the URL. Without this fallback, prev/next walks
    the whole catalogue while the URL still claims a filter is applied — you could page
    from a Spanish demo into a UK one under `?market=Spain`.
    """
    if key in st.session_state:
        value = st.session_state[key]
    else:
        value = st.query_params.get(key)
    return default if value is None or value == "" else value


def filter_flag(key):
    """As filter_value, for toggles. Query params arrive as the strings 'true'/'false'."""
    if key in st.session_state:
        return bool(st.session_state[key])
    return str(st.query_params.get(key) or "").lower() == "true"


def active_filters():
    """Current filter values. Read from session state rather than the widgets, so the
    detail view can reuse them without rendering the grid controls."""
    text = filter_value("q", "")
    return {
        "terms": text.lower().split(),
        "query": text.strip(),
        "semantic": filter_flag("semantic"),
        "industry": filter_value("industry", ALL_INDUSTRIES),
        "market": filter_value("market", ALL_MARKETS),
        "persona": filter_value("persona", ALL_PERSONAS),
        "use_case": filter_value("use_case", ALL_USE_CASES),
        "feature": filter_value("feature", ALL_FEATURES),
        "live_only": filter_flag("live"),
        "sort": filter_value("sort", next(iter(SORTS))),
    }


def all_personas(repo):
    """Stated audience plus the personas the demo would also land with."""
    return (repo.get("personas") or []) + (repo.get("alsoFor") or [])


def matches(repo, f):
    if f["industry"] != ALL_INDUSTRIES and repo.get("industry") != f["industry"]:
        return False
    if f["market"] != ALL_MARKETS and repo.get("market") != f["market"]:
        return False
    if f["persona"] != ALL_PERSONAS and f["persona"] not in all_personas(repo):
        return False
    if f["use_case"] != ALL_USE_CASES and f["use_case"] not in (repo.get("useCases") or []):
        return False
    if f["feature"] != ALL_FEATURES and f["feature"] not in (repo.get("features") or []):
        return False
    if f["live_only"] and not repo.get("hasPage"):
        return False
    if not f["terms"]:
        return True
    haystack = " ".join(
        str(v) for v in [
            repo["name"],
            repo.get("description") or "",
            repo.get("headline") or "",
            repo.get("industry") or "",
            repo.get("market") or "",
            repo.get("audience") or "",
            *all_personas(repo),
            *(repo.get("useCases") or []),
            *(repo.get("features") or []),
            # Inferred phrasings, so "churn european fibre" finds a demo that only
            # ever says "Norway" and "broadband retention".
            *(repo.get("searchTerms") or []),
        ]
    ).lower()
    return all(t in haystack for t in f["terms"])


def any_facet_active(f):
    """Whether anything other than the search text is narrowing the results. Logged
    with each search so a zero-result row can be told apart from an over-filtered one."""
    return (
        f["industry"] != ALL_INDUSTRIES
        or f["market"] != ALL_MARKETS
        or f["persona"] != ALL_PERSONAS
        or f["use_case"] != ALL_USE_CASES
        or f["feature"] != ALL_FEATURES
        or f["live_only"]
    )


def visible_repos():
    """The filtered, sorted result set the user is currently looking at."""
    f = active_filters()

    if f["semantic"] and f["query"]:
        order = semantic_order(f["query"])
        if order:
            rank = {name: i for i, name in enumerate(order)}
            # The text test is dropped — relevance replaces it — but every other facet
            # still applies, so the dropdowns behave identically in either mode.
            unfiltered_text = {**f, "terms": []}
            return sorted(
                [
                    r for r in load_index()["repos"]
                    if matches(r, unfiltered_text) and r["name"] in rank
                ],
                key=lambda r: rank[r["name"]],
            )
        # order is None or empty: fall through to keyword rather than show nothing.

    matched = [r for r in load_index()["repos"] if matches(r, f)]
    if f["sort"] == MOST_USED:
        counts = view_counts()
        # Negated count rather than reverse=True, which would also flip the name
        # tie-breaker into Z-A.
        return sorted(matched, key=lambda r: (-counts.get(r["name"], 0), r["name"].lower()))
    key_fn, descending = SORTS.get(f["sort"], next(iter(SORTS.values())))
    return sorted(matched, key=key_fn, reverse=descending)


def neighbours(name):
    """Previous and next demo, following the active filters and sort so paging
    through a filtered view stays inside it."""
    names = [r["name"] for r in visible_repos()]
    if name not in names:
        # Reached by direct link from outside the current filter.
        names = sorted(r["name"] for r in load_index()["repos"])
        if name not in names:
            return None, None
    i = names.index(name)
    return (names[i - 1] if i > 0 else None), (names[i + 1] if i < len(names) - 1 else None)


def nav_row(name, key):
    prev_name, next_name = neighbours(name)
    with st.container(horizontal=True, gap="small"):
        st.button(
            "All projects",
            key=f"back_{key}",
            icon=":material/arrow_back:",
            on_click=close_repo,
        )
        if prev_name:
            st.button(
                clamp(prev_name, 22),
                key=f"prev_{key}",
                icon=":material/chevron_left:",
                help=f"Previous demo: {prev_name}",
                on_click=open_repo,
                args=(prev_name,),
            )
        if next_name:
            st.button(
                clamp(next_name, 22),
                key=f"next_{key}",
                icon=":material/chevron_right:",
                help=f"Next demo: {next_name}",
                on_click=open_repo,
                args=(next_name,),
            )
        render_share(
            "Share",
            "Opens the catalog on this demo.",
            repo=name,
        )


# ----------------------------------------------------------------- detail view

def render_detail(name):
    repo = load_repo(name)
    if repo is None or not in_catalog(repo):
        st.error(f"No catalog entry for `{name}`.", icon=":material/error:")
        st.button("All projects", icon=":material/arrow_back:", on_click=close_repo)
        return

    # Arriving from a screenshot click is a full document load rather than a rerun, so
    # an entrance animation here is what stands in for a view transition. Scoped to a
    # marker element because Streamlit gives the page container no class of its own.
    st.markdown('<span class="pc-detail-in"></span>', unsafe_allow_html=True)

    facet = load_facets().get(name) or {}
    tech = load_tech().get(name) or []
    dupe = load_duplicates().get(name) or {}
    b = repo.get("business") or {}
    site = repo.get("site") or {}
    documented = b.get("evidence_grade") != "insufficient"
    industry = facet.get("industry") or b.get("industry")
    market = facet.get("market")

    nav_row(name, "top")

    with st.container(horizontal=True, gap="small"):
        if documented and industry:
            st.badge(industry, color="blue")
        if market:
            st.badge(market, icon=":material/public:", color="violet")
        if site.get("hasPage"):
            st.badge("Live demo", icon=":material/bolt:", color="green")
        if repo.get("isPrivate"):
            # Violet rather than gray or orange: both fail WCAG AA on st.badge,
            # measured at 3.45:1 and 3.19:1 against its own background.
            st.badge("Private", icon=":material/lock:", color="violet")

    st.title(b["headline"] if documented and b.get("headline") else repo["name"])
    st.caption(f"{repo['name']} · updated {fmt_date(repo.get('pushedAt'))}")

    with st.container(horizontal=True, gap="small"):
        if site.get("url"):
            st.link_button(
                "Open live demo", site["url"],
                icon=":material/open_in_new:", type="primary",
            )
        if repo.get("url") or repo_url(repo):
            st.link_button(
                "Source on GitHub",
                repo.get("url") or repo_url(repo),
                icon=":material/code:",
            )
        pick_button(repo, "pick_detail")

    health = load_shots().get(repo["name"]) or {}
    if site.get("hasPage") and health.get("ok") is False:
        status = health.get("status")
        st.warning(
            "The live site did not respond when the catalog last checked it"
            + (f" (HTTP {status})." if status else ".")
            + " It may need redeploying \u2014 the source below is unaffected.",
            icon=":material/warning:",
        )

    if dupe.get("supersededBy"):
        newer = dupe["supersededBy"]
        with st.container(horizontal=True, gap="small", vertical_alignment="center"):
            st.caption(
                f"A newer version of this demo exists as **{newer}**. "
                "This one is kept for reference."
            )
            st.button(
                f"Open {clamp(newer, 26)}",
                key="superseded_by",
                icon=":material/update:",
                on_click=open_repo,
                args=(newer,),
            )

    if site.get("gated"):
        code = load_codes().get(repo["name"])
        if code:
            st.caption("This demo is behind an access screen. Use this code:")
            # Narrow column so the copy button sits beside the code, not 1000px away.
            st.columns([1, 3])[0].code(code, language=None, wrap_lines=False)
        else:
            st.caption(
                "This demo is behind an access screen and no code is on file — "
                "check the repo source."
            )

    main, aside = st.columns([2, 1], gap="large")

    with main:
        hero = shot_path(site.get("shot"))
        if hero:
            st.image(str(hero), width="stretch")
            caption = site.get("title") or repo["name"]
            url = (site.get("url") or "").replace("https://", "")
            st.caption(f"{caption} · {url}" if url else caption)

        # Read from shots.json rather than the detail file: the galleries are produced by
        # screenshot-gallery.mjs, and routing them through the detail files would mean
        # re-projecting all 53 demos to add a field only this row reads.
        gallery = load_shots().get(repo["name"], {}).get("gallery") or []
        if gallery:
            render_gallery(repo["name"], gallery)

        grade = b.get("evidence_grade")
        if grade == "insufficient":
            st.info(
                "This repository is empty or holds only raw files, so there is nothing "
                "to describe yet. Rather than invent a business story, the catalog "
                "leaves it blank.",
                icon=":material/info:",
            )
        elif grade == "from_screens":
            st.caption(
                "No written documentation was found, so this summary was derived from "
                "the demo's own on-screen text and data."
            )

        if documented:
            if b.get("business_problem"):
                st.subheader("The business problem")
                st.write(b["business_problem"])

            if b.get("solution"):
                st.subheader("What this demo shows")
                st.write(b["solution"])

            if b.get("key_capabilities"):
                st.subheader("What's inside")
                for cap in b["key_capabilities"]:
                    st.markdown(f"- {cap}")

            if b.get("business_value"):
                st.subheader("Business value")
                # A real list, so wrapped lines hang-indent like "What's inside".
                for value in b["business_value"]:
                    st.markdown(f"- {value}")

        render_technical(repo)
        render_pitch(name)

    with aside:
        render_facts(repo, b, site, industry, market)
        render_use_cases(facet)
        render_personas(facet)
        render_capabilities(tech)
        render_related(dupe)

    nav_row(name, "bottom")

    # Last, so the page is already drawn before the insert costs a round trip.
    log_view(name)


def render_technical(repo):
    languages = repo.get("languages") or []
    tree = repo.get("tree") or []
    commits = repo.get("commits") or []

    if not (languages or tree or commits):
        return

    with st.expander("Technical details", icon=":material/build:"):
        if languages:
            st.markdown("**Languages**")
            bar = "".join(
                f'<span style="width:{lang["percent"]}%;'
                f'background:{lang.get("color") or "#9aa5b1"}"></span>'
                for lang in languages
            )
            st.markdown(
                '<div style="display:flex;height:8px;border-radius:4px;'
                f'overflow:hidden;margin:4px 0 10px">{bar}</div>',
                unsafe_allow_html=True,
            )
            # Swatches so the bar's colours map to something.
            st.markdown(
                " ".join(
                    f'<span style="white-space:nowrap;margin-right:12px;font-size:.8rem">'
                    f'<span style="display:inline-block;width:9px;height:9px;border-radius:50%;'
                    f'background:{l.get("color") or "#9aa5b1"};margin-right:5px"></span>'
                    f'{l["name"]} {l["percent"]}%</span>'
                    for l in languages
                ),
                unsafe_allow_html=True,
            )

        if tree:
            st.markdown("**Files**")
            st.code(
                "\n".join(
                    f"{e['name']}/" if e.get("type") == "tree" else e["name"]
                    for e in tree
                ),
                language=None,
            )

        if commits:
            st.markdown("**Recent commits**")
            # Markdown rather than st.dataframe: the canvas-rendered table clipped
            # most messages mid-word in this narrow column, with no way to wrap.
            for c in commits[:10]:
                sha = (c.get("oid") or "")[:7]
                link = f"[`{sha}`]({c['url']})" if c.get("url") else f"`{sha}`"
                message = (c.get("message") or "").splitlines()[0]
                st.markdown(f"{link} {message} · {fmt_date(c.get('date'))}")


def render_personas(facet):
    """Who to show this demo to: the audience it was built for, plus the personas
    its capabilities would also land with."""
    stated = facet.get("personas") or []
    also = facet.get("alsoFor") or []
    if not (stated or also):
        return

    with st.container(border=True):
        st.subheader("Personas")
        if stated:
            st.caption("Built for")
            for name in stated:
                st.markdown(f":blue-badge[{name}]")
        if also:
            st.caption("Also relevant to")
            for name in also:
                st.markdown(f":gray-badge[{name}]")


def render_use_cases(facet):
    """What the demo is about, as distinct from who it is for."""
    use_cases = facet.get("useCases") or []
    if not use_cases:
        return
    with st.container(border=True):
        st.subheader("Use cases")
        for name in use_cases:
            st.markdown(f":violet-badge[{name}]")


def render_capabilities(features):
    """Snowflake capabilities found in the demo's own code and config — not claims
    from its documentation."""
    if not features:
        return
    with st.container(border=True):
        st.subheader("Snowflake capabilities")
        for name in features:
            st.markdown(f":blue-badge[{name}]")
        st.caption("Detected in the repo's SQL, Python and config files.")


def render_related(dupe):
    """Other demos covering the same subject. Deliberately not called "superseded":
    a shared customer means these are siblings, not replacements."""
    related = dupe.get("related") or []
    if not related:
        return
    with st.container(border=True):
        st.subheader("Related demos")
        for item in related:
            st.button(
                clamp(item["name"], 28),
                key=f"related_{item['name']}",
                icon=":material/link:",
                width="stretch",
                on_click=open_repo,
                args=(item["name"],),
            )
        st.caption("Same customer or subject, matched on name and wording.")


def render_pitch(name):
    """Customer-specific talking points for this demo. Hidden entirely — not
    disabled — wherever Cortex is unreachable, which is every host today."""
    if not ai_available():
        return

    with st.expander("Prepare for a customer conversation", icon=":material/campaign:"):
        customer = st.text_input(
            "Customer or prospect",
            key="pitch_customer",
            placeholder="e.g. Deutsche Telekom",
        )
        go = st.button(
            "Draft talking points",
            key="pitch_go",
            icon=":material/auto_awesome:",
            disabled=not customer.strip(),
            type="primary",
        )
        if go:
            with st.spinner("Drafting…"):
                draft = draft_pitch(name, customer.strip())
            if draft:
                st.markdown(draft)
                st.caption(
                    f"Generated by {PITCH_MODEL} from this demo's own summary. "
                    "Check the claims before sending anything."
                )
            else:
                st.caption("The draft could not be generated. Try again shortly.")


@st.cache_data(ttl=3600, show_spinner=False)
def draft_pitch(name, customer):
    """Cached on the demo and customer so re-opening the panel costs nothing.
    Returns None on any failure; the caller decides what to show."""
    repo = load_repo(name) or {}
    b = repo.get("business") or {}
    facet = load_facets().get(name) or {}
    brief = "\n".join(
        part for part in [
            f"Demo: {b.get('headline') or name}",
            f"Industry: {facet.get('industry')}" if facet.get("industry") else "",
            f"Market: {facet.get('market')}" if facet.get("market") else "",
            f"Audience: {b.get('target_audience')}" if b.get("target_audience") else "",
            f"Problem: {b.get('business_problem')}" if b.get("business_problem") else "",
            f"What it shows: {b.get('solution')}" if b.get("solution") else "",
            "Capabilities: " + "; ".join(b.get("key_capabilities") or [])
            if b.get("key_capabilities") else "",
            "Business value: " + "; ".join(b.get("business_value") or [])
            if b.get("business_value") else "",
        ] if part
    )
    prompt = (
        "You are helping a Snowflake sales engineer prepare to show an existing "
        f"demo to {customer}.\n\nUse only the demo brief below. Where something "
        f"depends on {customer}'s own situation, write it as a question to ask "
        "rather than an assertion. Do not invent metrics, customer names, or "
        "results that are not in the brief.\n\n"
        "Reply in markdown with exactly these three sections:\n"
        "### Why this demo fits\nThree bullets at most.\n"
        "### Questions to ask\nFour discovery questions that this demo would answer.\n"
        "### Intro message\nA short note of under 120 words requesting a session.\n\n"
        f"DEMO BRIEF:\n{brief}"
    )
    try:
        rows = session().sql(
            f"SELECT AI_COMPLETE('{PITCH_MODEL}', ?) AS pitch", params=[prompt]
        ).collect()
        return rows[0]["PITCH"] if rows else None
    except Exception:
        return None


def render_facts(repo, b, site, industry, market):
    with st.container(border=True):
        st.subheader("At a glance")
        facts = []
        if b.get("target_audience"):
            facts.append(("Audience", b["target_audience"]))
        if industry:
            facts.append(("Industry", industry))
        if market:
            facts.append(("Market", market))
        facts.append((
            "Live demo",
            ("Yes — access gated" if site.get("gated") else "Yes")
            if site.get("hasPage") else "No",
        ))
        facts += [
            ("Created", fmt_date(repo.get("createdAt"))),
            ("Last updated", fmt_date(repo.get("pushedAt"))),
        ]
        # Folded in from the old one-link "Team" panel.
        owners = repo.get("contributors") or []
        if owners:
            facts.append((
                "Maintainer",
                " · ".join(f"[{p['login']}]({p['url']})" for p in owners),
            ))
        grade = b.get("evidence_grade")
        facts.append((
            "Summary based on",
            {
                "documented": "Project documentation",
                "from_screens": "The demo's own screens",
            }.get(grade, "No content found"),
        ))
        views = view_counts().get(repo["name"], 0)
        if views:
            facts.append(("Opened from the catalog", f"{views} time{'' if views == 1 else 's'}"))
        for label, value in facts:
            st.caption(label)
            st.markdown(value)


# ------------------------------------------------------------------- grid view

def spotlight_pick(repos):
    """The demo to feature above the grid.

    SPOTLIGHT_PIN wins when it is set and still usable. With no pin it falls back to
    rotating on today's date, which changes daily without JavaScript — CSS cannot
    rotate content and a timer in the browser would mean a script.

    The fallback also covers a pin that has gone stale: if the named demo is renamed,
    removed or loses its screenshot, the banner quietly reverts to the rotation rather
    than disappearing.
    """
    candidates = sorted(
        (
            r
            for r in repos
            if r.get("grade") != "insufficient"
            and r.get("hasPage")
            and r.get("siteOk") is not False
            and not r.get("supersededBy")
            and shot_path(r.get("shot"))
        ),
        key=lambda r: r["name"].lower(),
    )
    if not candidates:
        return None
    if SPOTLIGHT_PIN:
        pinned = next((r for r in candidates if r["name"] == SPOTLIGHT_PIN), None)
        if pinned:
            return pinned
    return candidates[datetime.now(timezone.utc).date().toordinal() % len(candidates)]


def render_spotlight(repo):
    """Featured demo above the grid, deliberately a banner rather than a full hero:
    this is a tool for finding things, and everything above the grid costs scroll.

    Widget keys are prefixed because the same demo also appears in the grid below, and
    two widgets sharing a key is a hard error rather than a cosmetic one.
    """
    shot = shot_path(repo.get("shot"))
    if not shot:
        return
    with st.container(border=True):
        left, right = st.columns([1.1, 1], gap="medium", vertical_alignment="center")
        with left:
            st.markdown(
                f"""<a class="pc-spot" href="{html.escape(detail_link(repo['name']))}"
                target="_self" style="{BOX};text-decoration:none"
                ><img class="pc-spot-shot"
                      src="{thumb_uri(str(shot), stamp(shot), SPOT_WIDTH)}"
                      alt="Screenshot of the {html.escape(repo['name'])} demo"
                      style="{BOX};object-fit:cover;object-position:top center"
                ><span class="pc-sheen"></span></a>""",
                unsafe_allow_html=True,
            )
        with right:
            st.caption("Demo of the day")
            st.subheader(repo.get("headline") or repo["name"])
            kicker = [v for v in (repo.get("industry"), repo.get("market")) if v]
            if kicker:
                st.caption(" · ".join(kicker))
            if repo.get("audience"):
                st.caption(f"For {lead_lower(repo['audience'])}")
            with st.container(horizontal=True, gap="small"):
                st.button(
                    "View details",
                    key=f"spot_open_{repo['name']}",
                    icon=":material/arrow_forward:",
                    on_click=open_repo,
                    args=(repo["name"],),
                )
                if repo.get("siteUrl"):
                    st.link_button(
                        "Live site", repo["siteUrl"], icon=":material/open_in_new:"
                    )
                pick_button(repo, f"spot_pick_{repo['name']}", compact=True)


def render_sidebar():
    """Everything below the page nav: how to get access, and the two reference blocks
    that stop the same questions being asked twice.

    Two labelled groups rather than one stack of four identically-weighted controls. In
    that earlier arrangement two of the four opened a mail client and two expanded
    inline, with nothing in their appearance to say which — a full-width bordered
    control reads as a button, so the disclosure rows were promising an action they did
    not perform. The stylesheet now flattens the expanders for that reason, leaving
    three distinct weights: filled for the primary action, outlined for the secondary,
    flat for anything that merely opens.

    The group heading sits above the note card rather than inside it. Inside, it headed
    the prose only, which left the two buttons belonging to that group stranded outside
    the one box that named it.

    Deliberately does not repeat the tagline or the byline: both already appear in the
    hero band a few hundred pixels away, and having the same sentence twice on one
    screen reads as an oversight.
    """
    with st.sidebar:
        raw_html(
            '<p class="pc-side-label">Repo access</p>'
            '<div class="pc-side-panel">'
            f"<p>{html.escape(ACCESS_NOTE)}</p>"
            '<p class="pc-side-note">Live demos behind an access screen show their '
            "code on the demo's own page — no need to ask.</p>"
            "</div>"
        )
        st.link_button(
            "Email for repo access",
            ACCESS_MAILTO,
            icon=":material/mail:",
            width="stretch",
            type="primary",
        )
        st.link_button(
            "Request a new demo",
            REQUEST_MAILTO,
            icon=":material/add_circle:",
            width="stretch",
        )

        raw_html('<p class="pc-side-label pc-side-label-gap">Reference</p>')

        # Collapsed: both are read once and then in the way. Streamlit does not persist
        # expander state, so anything opened here re-closes on the next rerun — fine for
        # reference, which is why the access panel above is not in one.
        with st.expander("What the badges mean", icon=":material/label:"):
            st.markdown(":green-badge[live] &nbsp;Open it in a browser right now.")
            st.markdown(":red-badge[down] &nbsp;Did not respond at the last check.")
            st.markdown(":violet-badge[private] &nbsp;Repo needs access.")
            st.markdown(
                ":violet-badge[superseded] &nbsp;A newer demo covers this. Still "
                "listed, because the match is a guess."
            )
            if session() is not None:
                st.markdown(":blue-badge[12] &nbsp;Times opened from this catalog.")

        with st.expander("Picking one for a customer", icon=":material/lightbulb:"):
            tips = [
                "Filter by **market** first — a demo set in the customer's own "
                "country lands better than a generic one.",
                "Prefer a :green-badge[live] badge. Those need nothing set up.",
            ]
            # Only mentioned where the search service actually answers, so the tip
            # cannot point at a control that is not on the page.
            if search_available():
                tips.append(
                    "Use **Search by meaning** when you know the outcome you want "
                    "but not the wording."
                )
            tips += [
                "**Save** candidates, then copy the shortlist as a ready-made message.",
                "Check for :violet-badge[superseded] before you present anything.",
            ]
            st.markdown("\n".join(f"- {t}" for t in tips))

        st.divider()
        # The arrow marks it as leaving the app, which the two mail buttons above do not
        # need because their labels already say so. It also means the link is not relying
        # on colour alone, so the subtle resting underline can stay subtle.
        raw_html(
            f'<p class="pc-side-foot"><a href="{GITHUB_PROFILE}">'
            'All repos on GitHub<span aria-hidden="true"> ↗</span></a></p>'
        )


def render_hero(index):
    """The catalog header.

    One HTML block rather than st.title plus two st.caption calls. The default put the
    counts and the byline in grey lines of identical weight, so the numbers — the only
    figures on the page worth scanning — read as throwaway prose, and there was no
    hierarchy between them.
    """
    repos = index["repos"]
    stats = (
        (len(repos), "demos"),
        (sum(1 for r in repos if r.get("hasPage")), "live sites"),
        (len({r["market"] for r in repos if r.get("market")}), "markets"),
        (len({r["industry"] for r in repos if r.get("industry")}), "industries"),
    )
    tiles = "".join(
        f'<span class="pc-stat"><span class="pc-stat-n">{count}</span>'
        f'<span class="pc-stat-l">{label}</span></span>'
        for count, label in stats
    )
    updated = fmt_date(index.get("generatedAt"))
    raw_html(
        '<div class="pc-hero">'
        f'<h1 class="pc-hero-title">{html.escape(TITLE)}</h1>'
        f'<p class="pc-hero-sub">{html.escape(TAGLINE)}</p>'
        f'<div class="pc-stats">{tiles}</div>'
        '<div class="pc-hero-foot">'
        f"<span>{html.escape(OWNER)}</span>"
        f'<a href="mailto:{OWNER_EMAIL}">{OWNER_EMAIL}</a>'
        f"<span>Updated {html.escape(updated)}</span>"
        "</div></div>"
    )


def render_grid(index):
    repos = index["repos"]
    render_hero(index)

    # Every filter is bound to the URL, so a filtered view can be shared and
    # survives the round trip into a detail page and back. The widgets' return
    # values are unused: visible_repos() reads the same state, so the detail view
    # can apply the identical filters without rendering these controls.
    st.text_input(
        "Search",
        placeholder="Search by name, industry, market, persona, use case, capability or outcome…",
        label_visibility="collapsed",
        key="q",
        bind="query-params",
    )

    def options(field):
        return sorted({r.get(field) for r in repos if r.get(field)})

    def multi_options(field):
        return sorted({v for r in repos for v in (r.get(field) or [])})

    persona_options = sorted({p for r in repos for p in all_personas(r)})

    # Two rows: five facets plus sort and a toggle do not fit on one line legibly.
    # Four across, with the toggle taking the narrow last slot. The toggle used to sit
    # on the second row, where four controls could not fit: "All capabilities" overflowed
    # its box by 5px and "Recently updated" by 22px, so both were cut mid-letter. This
    # row had the spare width to absorb it.
    top = st.columns([1.1, 1, 1.05, 0.85], vertical_alignment="center")
    top[0].selectbox(
        "Industry",
        [ALL_INDUSTRIES] + options("industry"),
        label_visibility="collapsed",
        key="industry",
        bind="query-params",
    )
    top[1].selectbox(
        "Market",
        [ALL_MARKETS] + options("market"),
        label_visibility="collapsed",
        key="market",
        bind="query-params",
    )
    top[2].selectbox(
        "Persona",
        [ALL_PERSONAS] + persona_options,
        label_visibility="collapsed",
        key="persona",
        bind="query-params",
    )
    top[3].toggle("Live only", key="live", bind="query-params")

    bottom = st.columns([1, 1.05, 1.25], vertical_alignment="center")
    bottom[0].selectbox(
        "Use case",
        [ALL_USE_CASES] + multi_options("useCases"),
        label_visibility="collapsed",
        key="use_case",
        bind="query-params",
    )
    bottom[1].selectbox(
        "Snowflake capability",
        [ALL_FEATURES] + multi_options("features"),
        label_visibility="collapsed",
        key="feature",
        bind="query-params",
    )
    bottom[2].selectbox(
        "Sort by", sort_options(), label_visibility="collapsed",
        key="sort", bind="query-params",
    )

    # Rendered only where the search service answers, so nothing advertises a mode
    # that would fail. A shared ?semantic=true link is simply ignored elsewhere.
    if search_available():
        st.toggle(
            "Search by meaning",
            key="semantic",
            bind="query-params",
            help="Rank by what a demo is about rather than the words it happens to use.",
        )

    render_shortlist(repos)

    shown = visible_repos()

    f = active_filters()
    semantic_on = f["semantic"] and bool(f["query"])
    if semantic_on:
        # Cached, so this costs nothing beyond the call visible_repos() already made.
        if semantic_order(f["query"]):
            st.caption(
                "Ranked by relevance to your search, so the sort order above does "
                "not apply."
            )
        else:
            st.caption(
                "Search by meaning is unavailable right now — showing keyword "
                "matches instead.",
            )

    st.caption(
        f"Showing all {len(repos)}" if len(shown) == len(repos)
        else f"{len(shown)} of {len(repos)}"
    )

    # Before the early return below, so the zero-result searches — the ones actually
    # worth reading later — are the ones guaranteed to be recorded.
    log_search(
        f["query"],
        len(shown),
        "semantic" if semantic_on and semantic_order(f["query"]) else "keyword",
        any_facet_active(f),
    )

    if not shown:
        st.caption("No demos match those filters.")
        return

    pages = max(1, (len(shown) + PAGE_SIZE - 1) // PAGE_SIZE)
    # Narrowing the filters can strand the URL on a page that no longer exists.
    if st.session_state.get("page", 1) > pages:
        st.session_state["page"] = 1

    # The control lives below the grid, where you end up after scrolling; the slot
    # above it just reports position, so there is only one source of truth.
    indicator = st.empty()
    grid = st.container()

    page = 1
    if pages > 1:
        with st.container(horizontal_alignment="right"):
            page = st.pagination(pages, key="page", bind="query-params")
        indicator.caption(f"Page {page} of {pages}")

    window = shown[(page - 1) * PAGE_SIZE: page * PAGE_SIZE]
    with grid:
        # Only on an untouched first page. Once someone has searched or filtered, a
        # demo they did not ask for sitting above their results is just noise.
        if page == 1 and not f["query"] and not any_facet_active(f):
            featured = spotlight_pick(repos)
            if featured:
                render_spotlight(featured)
        for start in range(0, len(window), CARDS_PER_ROW):
            row = window[start: start + CARDS_PER_ROW]
            for column, repo in zip(st.columns(CARDS_PER_ROW, gap="medium"), row):
                with column:
                    render_card(repo)


def render_card(repo):
    documented = repo.get("grade") != "insufficient"
    with st.container(border=True, height="stretch"):
        shot = shot_path(repo.get("shot"))
        if shot:
            card_thumb(repo, shot)
        else:
            tile(repo)

        # This inner container absorbs the row's spare height, which pushes the
        # buttons to the bottom of every card so they line up across a row.
        with st.container(height="stretch", gap="small"):
            kicker = [v for v in (repo.get("industry"), repo.get("market")) if v]
            if documented and kicker:
                st.caption(" · ".join(kicker))
            headline = repo["headline"] if documented and repo.get("headline") else repo["name"]
            st.markdown(f"**{clamp(headline, HEADLINE_LIMIT)}**")
            if documented and repo.get("audience"):
                st.caption(f"For {clamp(lead_lower(repo['audience']), AUDIENCE_LIMIT)}")

            with st.container(horizontal=True, gap="small"):
                st.caption(repo["name"])
                if repo.get("hasPage"):
                    st.badge("live", color="green")
                if repo.get("siteOk") is False:
                    st.badge("down", icon=":material/warning:", color="red")
                if repo.get("supersededBy"):
                    # Violet, not gray or orange: both fail WCAG AA on st.badge
                    # (measured 3.45:1 and 3.19:1). Violet clears it at ~7:1.
                    st.badge("superseded", icon=":material/update:", color="violet")
                if repo.get("isPrivate"):
                    st.badge("private", color="violet")
                # Empty dict off-Snowflake, so this renders nothing there.
                views = view_counts().get(repo["name"], 0)
                if views:
                    st.badge(
                        str(views), icon=":material/visibility:", color="blue"
                    )

        # Save sits beside View details rather than in the link row below. With three
        # buttons that row wrapped onto two lines on cards that have a live site and
        # stayed on one where there is none, so View details no longer lined up
        # across a row. Two rows on every card restores that.
        with st.container(horizontal=True, gap="small"):
            st.button(
                "View details",
                key=f"open_{repo['name']}",
                icon=":material/arrow_forward:",
                width="stretch",
                on_click=open_repo,
                args=(repo["name"],),
            )
            pick_button(repo, f"pick_{repo['name']}", compact=True)

        with st.container(horizontal=True, gap="small"):
            source = repo_url(repo)
            if source:
                st.link_button(
                    "GitHub", source, icon=":material/code:", width="stretch"
                )
            if repo.get("siteUrl"):
                st.link_button(
                    "Live site",
                    repo["siteUrl"],
                    icon=":material/open_in_new:",
                    width="stretch",
                )


# -------------------------------------------------------------- analytics page

# Below this many recorded opens, "never opened" says more about how long the log has
# been running than about the demo, so it is not used as a retirement signal yet.
VIEWS_FOR_CONFIDENCE = 50
STALE_DAYS = 365


@st.cache_data(ttl=300, show_spinner=False)
def usage_totals():
    if session() is None:
        return {}
    try:
        row = session().sql(
            f"""SELECT (SELECT COUNT(*) FROM {VIEWS_TABLE})                       AS opens,
                       (SELECT COUNT(DISTINCT REPO_NAME) FROM {VIEWS_TABLE})      AS demos_opened,
                       (SELECT COUNT(DISTINCT VIEWER) FROM {VIEWS_TABLE})         AS people,
                       (SELECT COUNT(*) FROM {SEARCHES_TABLE})                    AS searches,
                       (SELECT COUNT(*) FROM {SEARCHES_TABLE}
                         WHERE RESULT_COUNT = 0)                                  AS empty_searches"""
        ).collect()[0]
        return {k.lower(): int(row[k] or 0) for k in
                ("OPENS", "DEMOS_OPENED", "PEOPLE", "SEARCHES", "EMPTY_SEARCHES")}
    except Exception:
        return {}


@st.cache_data(ttl=300, show_spinner=False)
def opens_by_day():
    if session() is None:
        return []
    try:
        rows = session().sql(
            f"""SELECT TO_CHAR(VIEWED_AT::DATE, 'YYYY-MM-DD') AS day, COUNT(*) AS opens
                FROM {VIEWS_TABLE}
                WHERE VIEWED_AT >= DATEADD('day', -60, CURRENT_TIMESTAMP())
                GROUP BY 1 ORDER BY 1"""
        ).collect()
        return [{"day": r["DAY"], "opens": int(r["OPENS"])} for r in rows]
    except Exception:
        return []


@st.cache_data(ttl=300, show_spinner=False)
def top_demos(limit=15):
    if session() is None:
        return []
    try:
        rows = session().sql(
            f"""SELECT REPO_NAME AS name, COUNT(*) AS opens
                FROM {VIEWS_TABLE} GROUP BY 1 ORDER BY opens DESC, name LIMIT {int(limit)}"""
        ).collect()
        return [{"Demo": r["NAME"], "Opens": int(r["OPENS"])} for r in rows]
    except Exception:
        return []


@st.cache_data(ttl=300, show_spinner=False)
def search_rollup(empty_only, limit=25):
    """Distinct queries with how often they ran and what they returned."""
    if session() is None:
        return []
    try:
        rows = session().sql(
            f"""SELECT LOWER(QUERY) AS q, COUNT(*) AS times,
                       ROUND(AVG(RESULT_COUNT), 1) AS avg_results,
                       COUNT_IF(FILTERED) AS while_filtered
                FROM {SEARCHES_TABLE}
                {'WHERE RESULT_COUNT = 0' if empty_only else ''}
                GROUP BY 1 ORDER BY times DESC, q LIMIT {int(limit)}"""
        ).collect()
        return [
            {
                "Search": r["Q"],
                "Times": int(r["TIMES"]),
                "Avg results": float(r["AVG_RESULTS"] or 0),
                "With filters on": int(r["WHILE_FILTERED"]),
            }
            for r in rows
        ]
    except Exception:
        return []


def retire_candidates():
    """Demos worth removing, each with its reason. A recommendation only — nothing is
    hidden automatically, because a wrong call here is worse than a list to skim."""
    counts = view_counts()
    total_views = sum(counts.values())
    trust_views = total_views >= VIEWS_FOR_CONFIDENCE
    cutoff = (datetime.now(timezone.utc) - timedelta(days=STALE_DAYS)).isoformat()

    rows = []
    for repo in load_index()["repos"]:
        pushed = repo.get("pushedAt") or ""
        stale = bool(pushed) and pushed < cutoff
        opens = counts.get(repo["name"], 0)
        reasons = []
        if repo.get("supersededBy"):
            reasons.append(f"superseded by {repo['supersededBy']}")
        if stale and trust_views and opens == 0:
            reasons.append("no update in a year and never opened")
        if not reasons:
            continue
        # Not a trigger on its own, but worth knowing once it is on the list.
        if repo.get("siteOk") is False:
            reasons.append("live site not responding")
        rows.append({
            "Demo": repo["name"],
            "Last updated": fmt_date(repo.get("pushedAt")),
            "Opens": opens,
            "Why": "; ".join(reasons),
        })
    return rows, trust_views, total_views


def sparkline(values, height=56):
    """A trend line that draws itself in, as inline SVG.

    Hand-rolled rather than charted because Vega-Lite has no entrance animation. This
    is a summary sitting beside the numbers, not a replacement for the interactive
    chart below it. Stroke and fill are set as presentation attributes rather than in
    the stylesheet, so without the stylesheet this degrades to a static line instead
    of a black blob.
    """
    if len(values) < 2:
        return ""
    width = 720
    lo, hi = min(values), max(values)
    span = (hi - lo) or 1
    step = width / (len(values) - 1)
    pts = [
        (i * step, height - 3 - (v - lo) / span * (height - 6))
        for i, v in enumerate(values)
    ]
    line = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
    return (
        f'<svg class="pc-spark" viewBox="0 0 {width} {height}" '
        f'preserveAspectRatio="none" aria-hidden="true" '
        f'style="display:block;width:100%;height:{height}px">'
        f'<polygon class="pc-spark-fill" fill="rgba(41,181,232,.12)" stroke="none" '
        f'points="0,{height} {line} {width},{height}"/>'
        f'<polyline class="pc-spark-line" fill="none" stroke="#29B5E8" '
        f'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" '
        f'points="{line}"/></svg>'
    )


def bar_rows(rows, label_key, value_key):
    """Ranked rows as bars that grow in, replacing a table whose only real content is
    relative size. Divs nest inside divs safely here; the reparenting trap is a block
    element inside an inline one, which is why the card markup uses spans throughout."""
    top = max((r[value_key] for r in rows), default=0) or 1
    out = ['<div class="pc-bars">']
    for i, row in enumerate(rows):
        label = html.escape(str(row[label_key]))
        out.append(
            f'<div class="pc-bar-row">'
            f'<span class="pc-bar-name" title="{label}">{label}</span>'
            f'<span class="pc-bar-track"><span class="pc-bar-fill" '
            f'style="--w:{100 * row[value_key] / top:.1f}%;--d:{i * 40}ms"></span></span>'
            f'<span class="pc-bar-count">{row[value_key]:,}</span>'
            f"</div>"
        )
    out.append("</div>")
    return "".join(out)


def render_analytics():
    st.title("Catalog usage")
    st.caption(
        "Only aggregates are shown, deliberately: this page is open to everyone who "
        "can open the catalog."
    )

    totals = usage_totals()
    if not totals:
        # Two quite different situations, and telling them apart saves a support round:
        # off Snowflake there is nothing to reach, whereas a live session that cannot
        # read the tables is a grant problem.
        if session() is None:
            st.info(
                "Usage is only recorded in Snowflake. Running the catalog locally, "
                "there is no session to read from — open the deployed app to see "
                "opens, searches and retire candidates.",
                icon=":material/info:",
            )
        else:
            st.warning(
                f"Connected, but `{VIEWS_TABLE}` and `{SEARCHES_TABLE}` could not be "
                "read. That is usually a missing SELECT grant on this role rather than "
                "an absence of data.",
                icon=":material/lock:",
            )
        return

    catalog_size = len(load_index()["repos"])
    empty = totals["empty_searches"]
    searches = totals["searches"]
    cols = st.columns(5)
    cols[0].metric("Demo opens", f"{totals['opens']:,}")
    cols[1].metric("Demos opened", f"{totals['demos_opened']} of {catalog_size}")
    cols[2].metric("People", f"{totals['people']:,}")
    cols[3].metric("Searches", f"{searches:,}")
    cols[4].metric(
        "Found nothing",
        f"{empty:,}",
        delta=f"{round(100 * empty / searches)}% of searches" if searches else None,
        delta_color="off",
    )

    # Viewer identity comes from Streamlit's own viewer context, not CURRENT_USER(),
    # which under owner's rights reports the owner for everybody. Whether it is truly
    # per-viewer is unproven: the first recorded row carried the owner's email, and the
    # owner was also the viewer, so that sample cannot tell the two apart. If opens keep
    # climbing while this stays at one, it is reporting the owner and nothing more.
    if totals["opens"] > 5 and totals["people"] <= 1:
        st.caption(
            "One person is recorded across every open, so the app is seeing its owner "
            "rather than each viewer. Read **People** as unavailable, not as a real one."
        )

    if totals["opens"] == 0 and searches == 0:
        st.caption(
            "Nothing recorded yet. Logging started when this page was built, so the "
            "numbers begin from first use rather than from the catalog's history."
        )
        return

    by_day = opens_by_day()
    # A compact trend beside the numbers, with the interactive chart still below for
    # reading values off. Last 30 days only: the sparkline is for shape, not detail.
    recent = [r["opens"] for r in by_day][-30:]
    if len(recent) >= 2:
        st.markdown(sparkline(recent), unsafe_allow_html=True)
        st.caption(f"Opens across the last {len(recent)} days with activity")

    if by_day:
        st.subheader("Opens per day")
        st.line_chart(by_day, x="day", y="opens", height=220)

    left, right = st.columns(2, gap="large")

    with left:
        st.subheader("Most opened")
        rows = top_demos()
        if rows:
            # Bars rather than a table: the only thing being read here is relative
            # size, and a table makes you do that comparison yourself.
            st.markdown(bar_rows(rows, "Demo", "Opens"), unsafe_allow_html=True)
        else:
            st.caption("No demos opened yet.")

        st.subheader("Never opened")
        opened = {r["Demo"] for r in top_demos(limit=1000)}
        never = sorted(
            r["name"] for r in load_index()["repos"] if r["name"] not in opened
        )
        st.caption(f"{len(never)} of {catalog_size} demos")
        if never:
            st.dataframe(
                [{"Demo": n} for n in never], hide_index=True, height=260,
                width="stretch",
            )

    with right:
        st.subheader("Searches that found nothing")
        st.caption(
            "The most actionable list here: either the demo does not exist, or it "
            "does and the words people use are missing from the index."
        )
        empty_rows = search_rollup(empty_only=True)
        if empty_rows:
            st.dataframe(empty_rows, hide_index=True, width="stretch")
        else:
            st.caption("No fruitless searches recorded.")

        st.subheader("Most common searches")
        all_rows = search_rollup(empty_only=False)
        if all_rows:
            st.dataframe(all_rows, hide_index=True, width="stretch")
        else:
            st.caption("No searches recorded.")

    st.subheader("Retirement candidates")
    rows, trust_views, total_views = retire_candidates()
    if not trust_views:
        st.caption(
            f"Only {total_views} opens recorded so far, which is too few to treat "
            f"\u201cnever opened\u201d as meaningful \u2014 below {VIEWS_FOR_CONFIDENCE} it would flag "
            "every older demo. Until then this lists supersessions only."
        )
    if rows:
        st.dataframe(rows, hide_index=True, width="stretch")
        st.caption(
            "Nothing is hidden automatically. Superseded demos stay in the catalog, "
            "with a note pointing at the current version."
        )
    else:
        st.caption("Nothing worth retiring.")


# ------------------------------------------------------------------------ main

def catalog_page():
    inject_css()
    render_sidebar()
    current = st.query_params.get("repo")
    if current:
        render_detail(current)
    else:
        render_grid(load_index())


def usage_page():
    inject_css()
    render_sidebar()
    render_analytics()


pages = [
    st.Page(catalog_page, title="Catalog", icon=":material/grid_view:", default=True),
    # Registered unconditionally. Gating it on a Snowflake session meant a local run had
    # only one page, and Streamlit renders no nav at all below two — so there was no way
    # to reach the analytics, and no sign the page existed. It states plainly when the
    # usage tables are out of reach, which is more use than being invisible.
    st.Page(usage_page, title="Usage", icon=":material/insights:"),
]

st.navigation(pages).run()
