import React from 'react';
import { 
  CheckSquare, 
  Square, 
  MinusSquare, 
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Loader2 
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { Skeleton } from '../ui/Skeleton';

export interface ColumnDef<T> {
  id: string;
  header: React.ReactNode;
  accessorKey?: keyof T;
  cell?: (item: T, index: number) => React.ReactNode;
  width?: string;
  align?: 'left' | 'center' | 'right';
  sortable?: boolean;
  className?: string;
}

export interface DataTableProps<T> {
  columns: ColumnDef<T>[];
  data: T[];
  loading?: boolean;
  rowKey?: (item: T) => string | number;
  // Selection
  selectable?: boolean;
  selectedIds?: (string | number)[];
  onToggleSelect?: (id: string | number) => void;
  onToggleSelectAll?: () => void;
  isAllSelected?: boolean;
  isSomeSelected?: boolean;
  // Sorting
  sortColumn?: string;
  sortDirection?: 'asc' | 'desc';
  onSort?: (columnId: string) => void;
  // Actions & Callbacks
  onRowClick?: (item: T) => void;
  emptyState?: React.ReactNode;
  pagination?: React.ReactNode;
  className?: string;
}

export function DataTable<T>({
  columns,
  data,
  loading = false,
  rowKey = (item: any) => item.id,
  selectable = false,
  selectedIds = [],
  onToggleSelect,
  onToggleSelectAll,
  isAllSelected = false,
  isSomeSelected = false,
  sortColumn,
  sortDirection,
  onSort,
  onRowClick,
  emptyState,
  pagination,
  className,
}: DataTableProps<T>) {
  const alignClasses = {
    left: 'text-left',
    center: 'text-center',
    right: 'text-right',
  };

  return (
    <div className={cn('vuexy-card overflow-hidden shadow-sm flex flex-col', className)}>
      <div className="overflow-x-auto min-w-full flex-1 overscroll-x-contain">
        <table className="w-full text-left border-collapse text-xs">
          {/* Table Header */}
          <thead>
            <tr className="border-b border-slate-200/80 dark:border-white/[0.08] bg-slate-50/75 dark:bg-white/[0.02] text-slate-500 dark:text-[#7E7F96] font-bold uppercase tracking-wider text-[11px]">
              {/* Optional Selection Checkbox */}
              {selectable && (
                <th className="py-3.5 px-4 w-10 text-center">
                  <button
                    type="button"
                    onClick={onToggleSelectAll}
                    className="p-1 rounded hover:bg-slate-200 dark:hover:bg-white/[0.08] text-slate-500 dark:text-slate-300 transition-colors cursor-pointer"
                  >
                    {isAllSelected ? (
                      <CheckSquare className="w-4 h-4 text-[#7367F0]" />
                    ) : isSomeSelected ? (
                      <MinusSquare className="w-4 h-4 text-[#7367F0]" />
                    ) : (
                      <Square className="w-4 h-4 text-slate-400" />
                    )}
                  </button>
                </th>
              )}

              {columns.map((col) => {
                const isSorted = sortColumn === col.id;
                return (
                  <th
                    key={col.id}
                    className={cn(
                      'py-3.5 px-4 select-none',
                      alignClasses[col.align || 'left'],
                      col.width,
                      col.className
                    )}
                  >
                    {col.sortable && onSort ? (
                      <button
                        type="button"
                        onClick={() => onSort(col.id)}
                        className="inline-flex items-center space-x-1.5 font-bold uppercase tracking-wider hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer group"
                      >
                        <span>{col.header}</span>
                        {isSorted ? (
                          sortDirection === 'asc' ? (
                            <ArrowUp className="w-3.5 h-3.5 text-[#7367F0]" />
                          ) : (
                            <ArrowDown className="w-3.5 h-3.5 text-[#7367F0]" />
                          )
                        ) : (
                          <ArrowUpDown className="w-3 h-3 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>

          {/* Table Body */}
          <tbody className="divide-y divide-slate-100 dark:divide-white/[0.04] text-slate-700 dark:text-slate-300 font-medium">
            {loading ? (
              // Loading Skeleton Rows
              Array.from({ length: 5 }).map((_, idx) => (
                <tr key={`skeleton-${idx}`}>
                  {selectable && (
                    <td className="py-4 px-4 text-center">
                      <Skeleton variant="rectangular" width={16} height={16} className="mx-auto" />
                    </td>
                  )}
                  {columns.map((col) => (
                    <td key={`skeleton-cell-${col.id}`} className="py-4 px-4">
                      <Skeleton variant="text" width="80%" height={14} />
                    </td>
                  ))}
                </tr>
              ))
            ) : data.length === 0 ? (
              // Empty State
              <tr>
                <td colSpan={columns.length + (selectable ? 1 : 0)} className="p-0">
                  {emptyState || (
                    <div className="py-12 text-center text-slate-400 text-xs font-bold">
                      No records found.
                    </div>
                  )}
                </td>
              </tr>
            ) : (
              // Actual Data Rows
              data.map((item, idx) => {
                const key = rowKey(item);
                const isSelected = selectedIds.includes(key);

                return (
                  <tr
                    key={key}
                    onClick={() => onRowClick && onRowClick(item)}
                    className={cn(
                      'transition-colors group',
                      onRowClick && 'cursor-pointer',
                      isSelected
                        ? 'bg-[#7367F0]/10 dark:bg-[#7367F0]/15'
                        : 'hover:bg-slate-50/70 dark:hover:bg-white/[0.02]'
                    )}
                  >
                    {selectable && (
                      <td className="py-3.5 px-4 text-center" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => onToggleSelect && onToggleSelect(key)}
                          className="p-1 rounded hover:bg-slate-200 dark:hover:bg-white/[0.08] text-slate-500 dark:text-slate-300 transition-colors cursor-pointer"
                        >
                          {isSelected ? (
                            <CheckSquare className="w-4 h-4 text-[#7367F0]" />
                          ) : (
                            <Square className="w-4 h-4 text-slate-300 dark:text-slate-600 group-hover:text-slate-400" />
                          )}
                        </button>
                      </td>
                    )}

                    {columns.map((col) => (
                      <td
                        key={col.id}
                        className={cn(
                          'py-3.5 px-4',
                          alignClasses[col.align || 'left'],
                          col.className
                        )}
                      >
                        {col.cell
                          ? col.cell(item, idx)
                          : col.accessorKey
                          ? (item[col.accessorKey] as any)
                          : null}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Table Pagination Footer */}
      {pagination && <div className="border-t border-slate-100 dark:border-white/[0.06]">{pagination}</div>}
    </div>
  );
}
