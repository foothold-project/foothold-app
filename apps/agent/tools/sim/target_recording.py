"""Record all native target attempts, including Sim.start's default joints."""
import ast
import time


class Publications:
    def __init__(self):
        self.value = dict(complete=True, attempts=0, count=0,
                          first_monotonic_ns=None, last_monotonic_ns=None)

    def publish(self, publisher, message):
        now = time.monotonic_ns()
        self.value['attempts'] += 1
        self.value['last_monotonic_ns'] = now
        if self.value['first_monotonic_ns'] is None:
            self.value['first_monotonic_ns'] = now
        # Mark in flight before entering native transport; failure stays unproven.
        self.value['complete'] = False
        result = publisher.publish(message)
        self.value['count'] += 1
        self.value['complete'] = True
        return result


def instrument(tree):
    """Known target hook only; no Gazebo, ROS, policy or STOP behavior changes."""
    sim = next((n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Sim'), None)
    # Runtimes without this transport supply no target counter. A manifest
    # without the field remains ineligible for substitute proof.
    if sim is None:
        if any(isinstance(n, ast.Constant) and n.value == '/fh_v2/target' for n in ast.walk(tree)):
            raise ValueError('native target class hook changed')
        return tree
    sends = [n for n in sim.body if isinstance(n, ast.FunctionDef) and n.name == 'send']
    if len(sends) != 1:
        raise ValueError('native target send hook changed')
    class Target(ast.NodeTransformer):
        count = 0
        def visit_Call(self, node):
            if ast.dump(node.func) == ast.dump(ast.parse('self.pub.publish', mode='eval').body):
                if len(node.args) != 1 or node.keywords:
                    raise ValueError('native target publish arguments changed')
                self.count += 1
                return ast.copy_location(ast.Call(func=ast.Name(id='_fh_targets_publish', ctx=ast.Load()),
                    args=[ast.parse('self.pub', mode='eval').body, node.args[0]], keywords=[]), node)
            return self.generic_visit(node)
    target = Target()
    target.visit(sends[0])
    main = next((n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main'), None)
    saves = [] if main is None else [n for n in main.body if isinstance(n, ast.FunctionDef) and n.name == 'save']
    if target.count != 1 or len(saves) != 1:
        raise ValueError('native target manifest hook changed')
    saves[0].body.insert(0, ast.parse("man['native_target_publications'] = dict(_fh_targets_value)").body[0])
    return tree


def scope():
    recorder = Publications()
    return dict(_fh_targets_publish=recorder.publish, _fh_targets_value=recorder.value)


def compile_runtime(source, filename):
    return compile(ast.fix_missing_locations(instrument(ast.parse(source, filename))), filename, 'exec')


def main():
    # Standalone D1 path: keep the source's argv/import directory behavior.
    import sys
    from pathlib import Path
    path = Path(sys.argv[1])
    sys.argv = sys.argv[1:]
    sys.path.insert(0, str(path.parent))
    namespace = dict(__name__='__main__', __file__=str(path), **scope())
    exec(compile_runtime(path.read_text(), str(path)), namespace)


if __name__ == '__main__':
    main()
