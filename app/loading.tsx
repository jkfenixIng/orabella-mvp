import { Skeleton } from "@/src/shared/components/skeleton";

export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Skeleton className="h-64 w-full rounded-md bg-slate-200 dark:bg-slate-700 animate-pulse" />
      <Skeleton className="h-24 w-3/4 rounded-md bg-slate-200 dark:bg-slate-700 animate-pulse mt-4" />
      <Skeleton className="h-16 w-1/2 rounded-md bg-slate-200 dark:bg-slate-700 animate-pulse mt-2" />
      <Skeleton className="h-12 w-1/3 rounded-md bg-slate-200 dark:bg-slate-700 animate-pulse mt-2" />
      <Skeleton className="h-12 w-1/4 rounded-md bg-slate-200 dark:bg-slate-700 animate-pulse mt-2" />
    </div>
  );
}