"use client";

/**
 * Markets: every open Panta market, with one row to narrow it. Search, topic,
 * close time and sort all live in that row: the active ones show as small
 * tokens inside it, and the rest sit behind one filter button.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { readPref, writePref } from "@/lib/webapp/cache";
import { BffOffline } from "@/lib/webapp/bff";
import {
  activeFilterCount,
  DEFAULT_FILTERS,
  parseFilters,
  SORTS,
  WINDOWS,
  withinWindow,
  type MarketFilters,
} from "@/lib/webapp/filters";
import { topicIcon, topicLabel } from "@/lib/webapp/format";
import { MarketCard } from "../cards";
import { browserStorage, useNow } from "../data";
import { Icon } from "../Icon";
import { useCatalog } from "../queries";
import { LoadMore, SkeletonCards, StateScreen, TopBar } from "../ui";

export function MarketsScreen() {
  const now = useNow();
  const [filters, setFilters] = useState<MarketFilters>(() =>
    readPref(browserStorage(), "marketFilters", parseFilters, DEFAULT_FILTERS),
  );
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState(false);
  const panelId = "wa-market-filters";

  useEffect(() => {
    const { query: _q, ...keep } = filters;
    writePref(browserStorage(), "marketFilters", keep);
  }, [filters]);
  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.query === typed ? f : { ...f, query: typed })), 300);
    return () => clearTimeout(t);
  }, [typed]);

  const catalog = useCatalog(filters);
  const firstPage = catalog.data?.pages[0];
  const topics = useRef<string[]>([]);
  if (firstPage?.categories.length) topics.current = firstPage.categories.map((c) => c.category);
  const markets = useMemo(
    () => withinWindow(catalog.data?.pages.flatMap((p) => p.markets) ?? [], filters.window, now),
    [catalog.data, filters.window, now],
  );
  // A close-time window can empty a page that later pages would fill.
  useEffect(() => {
    if (!markets.length && catalog.hasNextPage && !catalog.isFetchingNextPage) void catalog.fetchNextPage();
  }, [markets.length, catalog]);
  const count = activeFilterCount(filters);
  const set = (patch: Partial<MarketFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const sort = SORTS.find((s) => s.id === filters.sort)!;
  const window = WINDOWS.find((w) => w.id === filters.window)!;

  return (
    <>
      <TopBar title="Markets" />
      <div className="wa-searchrow" role="search">
        <Icon name="search" size={20} />
        {count ? (
          <div className="wa-tokens">
            {filters.topic ? (
              <span className="wa-token">
                <Icon name={topicIcon(filters.topic)} size={14} />
                {topicLabel(filters.topic)}
                <button type="button" aria-label={`Remove ${topicLabel(filters.topic)}`} onClick={() => set({ topic: null })}>
                  <Icon name="cross" size={14} />
                </button>
              </span>
            ) : null}
            {filters.window !== "any" ? (
              <span className="wa-token">
                <Icon name="timer" size={14} />
                {window.label}
                <button type="button" aria-label={`Remove ${window.label}`} onClick={() => set({ window: "any" })}>
                  <Icon name="cross" size={14} />
                </button>
              </span>
            ) : null}
            {filters.sort !== DEFAULT_FILTERS.sort ? (
              <span className="wa-token">
                <Icon name={sort.icon} size={14} />
                {sort.label}
                <button type="button" aria-label={`Remove ${sort.label}`} onClick={() => set({ sort: DEFAULT_FILTERS.sort })}>
                  <Icon name="cross" size={14} />
                </button>
              </span>
            ) : null}
          </div>
        ) : null}
        <label htmlFor="wa-market-q" className="wa-sr">
          Search markets
        </label>
        <input
          id="wa-market-q"
          type="search"
          placeholder={count ? "Search" : "Search markets"}
          value={typed}
          enterKeyHint="search"
          autoComplete="off"
          onChange={(e) => setTyped(e.target.value)}
        />
        <button
          type="button"
          className="wa-filterbtn"
          aria-label={count ? `Filters, ${count} on` : "Filters"}
          aria-expanded={open}
          aria-controls={panelId}
          data-active={count > 0}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="settings-adjust" size={20} />
          {count && !open ? <span className="wa-badge">{count}</span> : null}
        </button>
      </div>

      {open ? (
        <div id={panelId} className="wa-filters">
          {topics.current.length ? (
            <div className="wa-filters-group" role="group" aria-label="Topic">
              <div className="wa-chips">
                {topics.current.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="wa-opt"
                    aria-pressed={filters.topic === t}
                    onClick={() => set({ topic: filters.topic === t ? null : t })}
                  >
                    <Icon name={topicIcon(t)} size={16} />
                    {topicLabel(t)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="wa-filters-group" role="group" aria-label="Closes">
            <div className="wa-chips">
              {WINDOWS.map((w) => (
                <button key={w.id} type="button" className="wa-opt" aria-pressed={filters.window === w.id} onClick={() => set({ window: w.id })}>
                  {w.id === "any" ? null : <Icon name="timer" size={16} />}
                  {w.label}
                </button>
              ))}
            </div>
          </div>
          <div className="wa-filters-group" role="group" aria-label="Sort">
            <div className="wa-chips">
              {SORTS.map((s) => (
                <button key={s.id} type="button" className="wa-opt" aria-pressed={filters.sort === s.id} onClick={() => set({ sort: s.id })}>
                  <Icon name={s.icon} size={16} />
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: 14 }}>
        {markets.length ? (
          <>
            <ul className="wa-list">
              {markets.map((m) => (
                <li key={m.id}>
                  <MarketCard market={m} />
                </li>
              ))}
            </ul>
            <LoadMore
              onVisible={() => catalog.hasNextPage && !catalog.isFetchingNextPage && catalog.fetchNextPage()}
              disabled={!catalog.hasNextPage}
            />
          </>
        ) : catalog.isPending ? (
          <SkeletonCards count={4} />
        ) : catalog.isError ? (
          <StateScreen
            art={catalog.error instanceof BffOffline ? "offline" : "error"}
            line={catalog.error instanceof BffOffline ? "You’re offline" : "Couldn’t load markets"}
            action={{ label: "Try again", onClick: () => void catalog.refetch() }}
          />
        ) : filters.query || count ? (
          <StateScreen
            art="search"
            line="Nothing matches"
            action={{
              label: "Clear",
              onClick: () => {
                setTyped("");
                setFilters(DEFAULT_FILTERS);
              },
            }}
          />
        ) : (
          <StateScreen art="empty_calls" line="No open markets right now" />
        )}
      </div>
    </>
  );
}
