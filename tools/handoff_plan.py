"""Select the current work phase without inheriting a completed foundation's progress."""
import json
from pathlib import Path


def load_plans(root):
    directory = Path(root) / 'docs/handoff'
    definition = json.loads((directory / 'work-plan.json').read_text(encoding='utf-8'))
    record = json.loads((directory / 'progress.json').read_text(encoding='utf-8'))
    result = [(definition, record)]
    if ('module_plan' in definition) != ('module_plan' in record):
        raise ValueError('Module definitions and progress must be introduced together')
    if 'module_plan' in definition:
        result.append((definition['module_plan'], record['module_plan']))
    plan_ids = [plan['plan_id'] for plan, _ in result]
    if len(set(plan_ids)) != len(plan_ids):
        raise ValueError('Duplicate plan ID')
    task_ids = []
    for plan, progress in result:
        if plan['plan_id'] != progress['plan_id']:
            raise ValueError('Progress belongs to another plan')
        items = {item['id']: item for item in plan['tasks']}
        states = progress['tasks']
        if not items or len(items) != len(plan['tasks']) or set(items) != set(states):
            raise ValueError('Progress and task definitions do not match')
        if any(state['status'] not in {'pending', 'in_progress', 'blocked', 'done'} for state in states.values()):
            raise ValueError('Unknown task status')
        visited, visiting = set(), set()
        def visit(ident):
            if ident in visiting:
                raise ValueError('Task dependency cycle')
            if ident in visited:
                return
            visiting.add(ident)
            for dependency in items[ident]['depends_on']:
                if dependency not in items:
                    raise ValueError('Unknown task dependency')
                visit(dependency)
            visiting.remove(ident)
            visited.add(ident)
        for ident, item in items.items():
            visit(ident)
            if states[ident]['status'] in {'in_progress', 'done'} and any(states[d]['status'] != 'done' for d in item['depends_on']):
                raise ValueError('Active/completed task has incomplete dependencies')
        task_ids.extend(items)
    if len(set(task_ids)) != len(task_ids):
        raise ValueError('Task IDs must be unique across phases')
    active = record.get('active_plan_id', definition['plan_id'])
    if active not in plan_ids:
        raise ValueError('Unknown active plan')
    if active != definition['plan_id'] and any(state['status'] != 'done' for state in record['tasks'].values()):
        raise ValueError('Module migration requires the completed foundation')
    return result, active


def select_plan(root, task_id=None):
    plans, active = load_plans(root)
    if task_id is None:
        return next(pair for pair in plans if pair[0]['plan_id'] == active)
    matches = [(plan, state) for plan, state in plans if any(item['id'] == task_id for item in plan['tasks'])]
    if len(matches) != 1:
        raise ValueError('Unknown task ID')
    return matches[0]
