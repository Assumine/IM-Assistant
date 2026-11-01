"""Development handoff phase selection; no application or private profile is started."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from tools.handoff_plan import select_plan
from tools.next_task import next_task


class HandoffPhases(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / 'docs/handoff').mkdir(parents=True)
        self.plan = {'plan_id': 'foundation', 'tasks': [{'id': 'R1', 'depends_on': []}]}
        self.progress = {'plan_id': 'foundation', 'tasks': {'R1': {'status': 'done'}}}

    def write(self):
        for name, value in [('work-plan', self.plan), ('progress', self.progress)]:
            (self.root / f'docs/handoff/{name}.json').write_text(json.dumps(value), encoding='utf-8')

    def modules(self):
        self.plan['module_plan'] = {'plan_id': 'modules', 'tasks': [
            {'id': 'Q1', 'depends_on': []}, {'id': 'Q2', 'depends_on': ['Q1']}]}
        self.progress['module_plan'] = {'plan_id': 'modules', 'tasks': {
            'Q1': {'status': 'pending'}, 'Q2': {'status': 'pending'}}}
        self.progress['active_plan_id'] = 'modules'

    def test_foundation_only_remains_readable(self):
        self.write()
        self.assertEqual(next_task(self.root)['status'], 'all_tasks_recorded_done')
        self.assertEqual(next_task(self.root)['completed_tasks'], 1)

    def test_active_modules_do_not_inherit_foundation_completion(self):
        self.modules(); self.write()
        actual = next_task(self.root)
        self.assertEqual((actual['plan_id'], actual['completed_tasks'], actual['total_tasks']), ('modules', 0, 2))
        self.assertEqual(actual['next_task']['id'], 'Q1')
        self.assertEqual(select_plan(self.root, 'R1')[0]['plan_id'], 'foundation')
        self.assertEqual(select_plan(self.root, 'Q2')[0]['plan_id'], 'modules')

    def test_progression_selects_the_next_ready_module(self):
        self.modules(); self.progress['module_plan']['tasks']['Q1']['status'] = 'done'; self.write()
        self.assertEqual(next_task(self.root)['next_task']['id'], 'Q2')

    def test_in_progress_and_blocked_are_preserved(self):
        self.modules(); self.progress['module_plan']['tasks']['Q1']['status'] = 'in_progress'; self.write()
        self.assertEqual(next_task(self.root)['next_task']['id'], 'Q1')
        self.progress['module_plan']['tasks']['Q1'] = {'status': 'blocked', 'blocked_reason': 'Login missing'}
        self.write()
        actual = next_task(self.root)
        self.assertEqual(actual['status'], 'blocked')
        self.assertEqual(actual['blocked'], [{'id': 'Q1', 'reason': 'Login missing'}])

    def test_rejects_mismatched_or_incomplete_phase_records(self):
        self.modules()
        for mutation in ['missing', 'plan', 'task', 'active', 'foundation']:
            with self.subTest(mutation=mutation):
                plan, progress = copy.deepcopy(self.plan), copy.deepcopy(self.progress)
                if mutation == 'missing': del self.plan['module_plan']
                if mutation == 'plan': self.progress['module_plan']['plan_id'] = 'other'
                if mutation == 'task': del self.progress['module_plan']['tasks']['Q2']
                if mutation == 'active': self.progress['active_plan_id'] = 'other'
                if mutation == 'foundation': self.progress['tasks']['R1']['status'] = 'pending'
                self.write()
                with self.assertRaises(ValueError): select_plan(self.root)
                self.plan, self.progress = plan, progress

    def test_rejects_duplicate_ids_cycles_and_unfinished_dependencies(self):
        self.modules()
        for mutation in ['duplicate', 'cycle', 'unknown-dependency', 'early-start', 'status']:
            with self.subTest(mutation=mutation):
                plan, progress = copy.deepcopy(self.plan), copy.deepcopy(self.progress)
                if mutation == 'duplicate':
                    self.plan['module_plan']['tasks'][0]['id'] = 'R1'
                    self.plan['module_plan']['tasks'][1]['depends_on'] = ['R1']
                    self.progress['module_plan']['tasks']['R1'] = self.progress['module_plan']['tasks'].pop('Q1')
                if mutation == 'cycle': self.plan['module_plan']['tasks'][0]['depends_on'] = ['Q2']
                if mutation == 'unknown-dependency': self.plan['module_plan']['tasks'][1]['depends_on'] = ['missing']
                if mutation == 'early-start': self.progress['module_plan']['tasks']['Q2']['status'] = 'in_progress'
                if mutation == 'status': self.progress['module_plan']['tasks']['Q1']['status'] = 'finished'
                self.write()
                with self.assertRaises(ValueError): select_plan(self.root)
                self.plan, self.progress = plan, progress

    def test_unknown_runtime_task_is_not_a_foundation_fallback(self):
        self.modules(); self.write()
        with self.assertRaises(ValueError): select_plan(self.root, 'missing')


if __name__ == '__main__':
    unittest.main()
