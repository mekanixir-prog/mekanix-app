"use client";
import { cn } from "@/lib/utils";
import { useState, useMemo } from "react";
import { Search, ArrowUpDown, ChevronLeft, ChevronRight, Inbox } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { EmptyState } from "./primitives";
import { useT } from "@/lib/use-t";
import { toPersianDigits } from "@/lib/format";

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => React.ReactNode;
  sortValue?: (row: T) => string | number;
  className?: string;
  width?: string;
}

export function AdminTable<T extends { id?: string }>({
  data,
  columns,
  searchable,
  searchKeys,
  onRowClick,
  pageSize = 10,
  emptyTitle,
  emptyIcon = Inbox,
}: {
  data: T[];
  columns: Column<T>[];
  searchable?: boolean;
  searchKeys?: (keyof T)[];
  onRowClick?: (row: T) => void;
  pageSize?: number;
  emptyTitle?: string;
  emptyIcon?: any;
}) {
  const { t, isFa } = useT();
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    let rows = data;
    if (searchable && query && searchKeys) {
      const q = query.toLowerCase();
      rows = rows.filter((r) => searchKeys.some((k) => String(r[k] ?? "").toLowerCase().includes(q)));
    }
    if (sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      if (col?.sortValue) {
        rows = [...rows].sort((a, b) => {
          const av = col.sortValue!(a);
          const bv = col.sortValue!(b);
          const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
          return sortDir === "asc" ? cmp : -cmp;
        });
      }
    }
    return rows;
  }, [data, query, sortKey, sortDir, columns, searchable, searchKeys]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);

  const toggleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const fmtNum = (n: number) => (isFa ? toPersianDigits(n) : String(n));
  const fmtRange = (a: number, b: number) => (isFa ? `${toPersianDigits(a)}–${toPersianDigits(b)}` : `${a}–${b}`);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {searchable && (
        <div className="border-b border-border p-2">
          <div className="relative max-w-xs">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} placeholder={`${t("common.search")}…`} className="h-8 pl-8 text-xs" />
          </div>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={cn("px-4 py-2.5 text-left font-medium", c.className)}
                  style={c.width ? { width: c.width } : undefined}
                >
                  {c.sortValue ? (
                    <button onClick={() => toggleSort(c.key)} className="inline-flex items-center gap-1 hover:text-foreground">
                      {c.header}
                      <ArrowUpDown className={cn("size-3", sortKey === c.key ? "text-amber" : "text-muted-foreground/60")} />
                    </button>
                  ) : c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="p-0">
                  <EmptyState icon={emptyIcon} title={emptyTitle ?? t("common.records")} className="rounded-none border-0" />
                </td>
              </tr>
            ) : (
              pageRows.map((row, i) => (
                <tr
                  key={row.id ?? i}
                  onClick={() => onRowClick?.(row)}
                  className={cn("border-t border-border hover:bg-muted/30", onRowClick && "cursor-pointer")}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={cn("px-4 py-2.5 align-middle", c.className)}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {filtered.length > pageSize && (
        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <span>{fmtRange(safePage * pageSize + 1, Math.min(filtered.length, (safePage + 1) * pageSize))} {t("common.of")} {fmtNum(filtered.length)}</span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="size-7 p-0" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}><ChevronLeft className="size-3.5" /></Button>
            <span className="px-1">{fmtNum(safePage + 1)} / {fmtNum(totalPages)}</span>
            <Button variant="ghost" size="sm" className="size-7 p-0" disabled={safePage >= totalPages - 1} onClick={() => setPage(safePage + 1)}><ChevronRight className="size-3.5" /></Button>
          </div>
        </div>
      )}
    </div>
  );
}

