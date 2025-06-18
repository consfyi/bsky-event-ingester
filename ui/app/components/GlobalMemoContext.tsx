import {
  createContext,
  DependencyList,
  MutableRefObject,
  useContext,
  useEffect,
  useRef,
} from "react";

interface CacheItem {
  refCount: number;
  deps: DependencyList;
  value: unknown;
}

const GlobalMemoContext = createContext<MutableRefObject<
  Record<string, CacheItem>
> | null>(null);

export function GlobalMemoProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const cache = useRef<Record<string, CacheItem>>({});

  return (
    <GlobalMemoContext.Provider value={cache}>
      {children}
    </GlobalMemoContext.Provider>
  );
}

export function useGlobalMemo<T>(
  key: string,
  factory: () => T,
  deps: DependencyList
): T {
  const cache = useContext(GlobalMemoContext)!.current;

  if (!Object.prototype.hasOwnProperty.call(cache, key)) {
    cache[key] = {
      refCount: 0,
      deps,
      value: factory(),
    };
  } else {
    const oldDeps = cache[key].deps;

    if (
      oldDeps.length != deps.length ||
      oldDeps.some((d, i) => deps[i] !== d)
    ) {
      cache[key] = {
        refCount: 0,
        deps,
        value: factory(),
      };
    }
  }

  useEffect(() => {
    if (!Object.prototype.hasOwnProperty.call(cache, key)) {
      return;
    }

    cache[key].refCount += 1;

    return () => {
      if (!Object.prototype.hasOwnProperty.call(cache, key)) {
        return;
      }

      cache[key].refCount -= 1;

      if (cache[key].refCount == 0) {
        delete cache[key];
      }
    };
  }, [cache, key]);

  return cache[key].value as T;
}
