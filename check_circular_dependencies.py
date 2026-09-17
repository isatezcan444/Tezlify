import os
import ast
import re
from pathlib import Path
from collections import defaultdict

ROOT = Path("/Users/isatezcan/Documents/Github/Tezlify")

def find_cycles(graph):
    # graph: node -> set of dependencies
    cycles = []
    visited = set()
    rec_stack = []

    def dfs(node, path):
        visited.add(node)
        rec_stack.append(node)

        for neighbor in graph.get(node, []):
            if neighbor not in visited:
                dfs(neighbor, path + [neighbor])
            elif neighbor in rec_stack:
                cycle_start = rec_stack.index(neighbor)
                cycle = rec_stack[cycle_start:] + [neighbor]
                cycles.append(cycle)

        rec_stack.pop()

    for n in list(graph.keys()):
        if n not in visited:
            dfs(n, [n])

    # Deduplicate cycles (canonical rotation)
    unique_cycles = set()
    formatted = []
    for c in cycles:
        # without last repeating element
        c_nodes = c[:-1]
        min_node = min(c_nodes)
        min_idx = c_nodes.index(min_node)
        canonical = tuple(c_nodes[min_idx:] + c_nodes[:min_idx])
        if canonical not in unique_cycles:
            unique_cycles.add(canonical)
            formatted.append(c)

    return formatted

def check_python_cycles():
    backend_app = ROOT / "backend" / "app"
    graph = defaultdict(set)

    for py_file in backend_app.glob("**/*.py"):
        rel = py_file.relative_to(ROOT)
        # convert to module path
        mod_parts = list(rel.parts)
        if mod_parts[-1] == "__init__.py":
            mod_parts.pop()
        else:
            mod_parts[-1] = mod_parts[-1][:-3]
        current_mod = ".".join(mod_parts)

        try:
            with open(py_file, "r", encoding="utf-8") as f:
                code = f.read()
            tree = ast.parse(code, filename=str(py_file))
        except Exception:
            continue

        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.startswith("backend.app"):
                        graph[current_mod].add(alias.name)
            elif isinstance(node, ast.ImportFrom):
                if node.module and node.module.startswith("backend.app"):
                    graph[current_mod].add(node.module)

    # Filter graph nodes to only app modules
    cycles = find_cycles({k: [v for v in vs if v in graph] for k, vs in graph.items()})
    return cycles

def check_ts_cycles():
    fe_src = ROOT / "frontend" / "src"
    graph = defaultdict(set)

    for ts_file in list(fe_src.glob("**/*.ts")) + list(fe_src.glob("**/*.tsx")):
        rel = str(ts_file.relative_to(fe_src))
        dir_rel = ts_file.parent

        try:
            with open(ts_file, "r", encoding="utf-8") as f:
                code = f.read()
        except Exception:
            continue

        # regex for import ... from '...'
        imports = re.findall(r"from\s+['\"]([^'\"]+)['\"]", code)
        imports += re.findall(r"import\s*\(\s*['\"]([^'\"]+)['\"]\s*\)", code)

        for imp in imports:
            if imp.startswith("."):
                # resolve relative
                resolved = (dir_rel / imp).resolve()
                # find match
                candidates = [
                    resolved,
                    resolved.with_suffix(".ts"),
                    resolved.with_suffix(".tsx"),
                    resolved / "index.ts",
                    resolved / "index.tsx"
                ]
                for c in candidates:
                    if c.exists() and c.is_file():
                        try:
                            rel_target = str(c.relative_to(fe_src))
                            graph[rel].add(rel_target)
                            break
                        except Exception:
                            pass

    cycles = find_cycles({k: list(v) for k, v in graph.items()})
    return cycles

def check_gateway_cycles():
    gw_src = ROOT / "whatsapp-gateway" / "src"
    graph = defaultdict(set)

    for js_file in gw_src.glob("**/*.js"):
        rel = str(js_file.relative_to(gw_src))
        dir_rel = js_file.parent

        try:
            with open(js_file, "r", encoding="utf-8") as f:
                code = f.read()
        except Exception:
            continue

        imports = re.findall(r"from\s+['\"]([^'\"]+)['\"]", code)
        imports += re.findall(r"import\s*\(\s*['\"]([^'\"]+)['\"]\s*\)", code)

        for imp in imports:
            if imp.startswith("."):
                resolved = (dir_rel / imp).resolve()
                candidates = [
                    resolved,
                    resolved.with_suffix(".js"),
                    resolved / "index.js"
                ]
                for c in candidates:
                    if c.exists() and c.is_file():
                        try:
                            rel_target = str(c.relative_to(gw_src))
                            graph[rel].add(rel_target)
                            break
                        except Exception:
                            pass

    cycles = find_cycles({k: list(v) for k, v in graph.items()})
    return cycles

if __name__ == "__main__":
    py_cycles = check_python_cycles()
    ts_cycles = check_ts_cycles()
    gw_cycles = check_gateway_cycles()

    print("=== PYTHON CIRCULAR DEPENDENCIES ===")
    if not py_cycles:
        print("  None detected (0 cycles)!")
    else:
        for c in py_cycles:
            print("  Cycle: " + " -> ".join(c))

    print("\n=== TYPESCRIPT CIRCULAR DEPENDENCIES ===")
    if not ts_cycles:
        print("  None detected (0 cycles)!")
    else:
        for c in ts_cycles:
            print("  Cycle: " + " -> ".join(c))

    print("\n=== GATEWAY CIRCULAR DEPENDENCIES ===")
    if not gw_cycles:
        print("  None detected (0 cycles)!")
    else:
        for c in gw_cycles:
            print("  Cycle: " + " -> ".join(c))
