import { useRef, useState, type ReactElement } from 'react'

import { ChevronDownIcon } from '@/components/icons'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { selectTriggerClassName } from '@/components/ui/select'
import { cn } from '@/lib/utils'

/** A platform category, its id as a string (Kick's numeric ids too). */
export type CategoryOption = { id: string; name: string }

/** Searching starts at this many characters, like the old Search button. */
export const CATEGORY_SEARCH_MIN = 2
const SEARCH_DELAY_MS = 300

/** The line under the results: what to type, that it is searching, or that nothing matched. */
export function categoryComboboxStatus({
  query,
  pending,
  resultCount,
  searchedQuery
}: {
  query: string
  pending: boolean
  resultCount: number
  searchedQuery: string | null
}): string | null {
  if (query.trim().length < CATEGORY_SEARCH_MIN) {
    return `Type ${CATEGORY_SEARCH_MIN} or more letters to search.`
  }
  if (pending || searchedQuery !== query.trim()) return 'Searching…'
  return resultCount === 0 ? 'No categories match.' : null
}

/**
 * The one category picker for Twitch and Kick (plan 174 S3.5b, D-30): a
 * Popover + Command built on the platforms' existing category search. Only a
 * picked category is chosen; typed text is a search, never the value.
 */
export function CategoryCombobox({
  id,
  label,
  value,
  results,
  pending,
  disabled = false,
  onSearch,
  onChange
}: {
  id: string
  label: string
  value: CategoryOption | null
  results: readonly CategoryOption[]
  pending: boolean
  disabled?: boolean
  onSearch: (query: string) => void
  onChange: (category: CategoryOption | null) => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [searchedQuery, setSearchedQuery] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  const search = (next: string): void => {
    setQuery(next)
    if (timer.current !== null) window.clearTimeout(timer.current)
    const trimmed = next.trim()
    if (trimmed.length < CATEGORY_SEARCH_MIN) return
    timer.current = window.setTimeout(() => {
      timer.current = null
      setSearchedQuery(trimmed)
      onSearch(trimmed)
    }, SEARCH_DELAY_MS)
  }
  const setOpenState = (next: boolean): void => {
    setOpen(next)
    if (!next && timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }
  const status = categoryComboboxStatus({
    query,
    pending,
    resultCount: results.length,
    searchedQuery
  })
  const shown = query.trim().length >= CATEGORY_SEARCH_MIN && !status ? results : []

  return (
    <Popover open={open} onOpenChange={setOpenState}>
      <PopoverTrigger asChild>
        <button
          aria-controls={`${id}-popup`}
          aria-expanded={open}
          aria-haspopup="dialog"
          className={cn(selectTriggerClassName, 'w-full min-w-0')}
          data-placeholder={value ? undefined : ''}
          data-size="default"
          disabled={disabled}
          id={id}
          role="combobox"
          type="button"
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {value ? value.name : 'Choose a category…'}
          </span>
          <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) min-w-64 gap-0 p-0"
        id={`${id}-popup`}
      >
        <Command shouldFilter={false}>
          <CommandInput
            aria-label={`Search ${label}`}
            autoFocus
            placeholder="Search categories…"
            value={query}
            onValueChange={search}
          />
          <CommandList label={label}>
            {shown.length || value ? (
              <CommandGroup className="p-1">
                {shown.map((category) => (
                  <CommandItem
                    data-checked={category.id === value?.id}
                    key={category.id}
                    value={category.id}
                    onSelect={() => {
                      onChange(category)
                      setOpenState(false)
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{category.name}</span>
                  </CommandItem>
                ))}
                {value ? (
                  <CommandItem
                    value="__clear"
                    onSelect={() => {
                      onChange(null)
                      setOpenState(false)
                    }}
                  >
                    <span className="text-muted-foreground">Clear category</span>
                  </CommandItem>
                ) : null}
              </CommandGroup>
            ) : null}
          </CommandList>
          {status ? (
            <p className="px-3 py-2 text-sm text-muted-foreground" role="status">
              {status}
            </p>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
