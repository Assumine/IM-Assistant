"""Plan-routing checks; these are not acceptance of the new OpenCode application."""

import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools import next_task, run_runtime_checks, validate_design

ROOT=Path(__file__).resolve().parents[1]


class PlanToolTests(unittest.TestCase):
    def setUp(self):
        parent=ROOT/'.reports/tool-tests'
        parent.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.plan=json.loads((ROOT/'docs/handoff/work-plan.json').read_text(encoding='utf-8'))
        self.progress=json.loads((ROOT/'docs/handoff/progress.json').read_text(encoding='utf-8'))
        # A plan-tool fixture must not change meaning as real implementation advances.
        self.plan.pop('module_plan',None)
        self.progress.pop('module_plan',None)
        self.progress.pop('active_plan_id',None)
        self.progress['implementation_started']=False
        self.progress['runtime_acceptance_completed']=[]
        for state in self.progress['tasks'].values():
            state.update(status='pending',artifacts=[],verification=[],blocked_reason=None)
        self.write()

    def write(self):
        for name,value in [('work-plan.json',self.plan),('progress.json',self.progress)]:
            path=self.root/'docs/handoff'/name
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text(json.dumps(value),encoding='utf-8')

    def test_current_plan_starts_at_source_baseline_without_old_client(self):
        with patch.object(next_task,'ROOT',self.root):
            result=next_task.next_task()
        self.assertEqual(result['plan_id'],'opencode-app-base-v2')
        self.assertEqual(result['next_task']['id'],'R0-01')
        self.assertEqual(result['completed_tasks'],0)
        self.assertEqual(result['local_client_reference']['status'],'not_configured')

    def test_wrong_progress_plan_cannot_resume_old_route(self):
        self.progress['plan_id']='old-python-host'
        self.write()
        with patch.object(next_task,'ROOT',self.root),self.assertRaisesRegex(ValueError,'another plan'):
            next_task.next_task()

    def test_incomplete_dependencies_cannot_be_marked_active(self):
        self.progress['tasks']['R1-01']['status']='in_progress'
        self.write()
        with patch.object(next_task,'ROOT',self.root),self.assertRaisesRegex(ValueError,'incomplete dependencies'):
            next_task.next_task()

    def test_old_task_does_not_silently_fall_back_in_active_plan(self):
        with patch.object(run_runtime_checks,'ROOT',self.root),self.assertRaisesRegex(ValueError,'Unknown task'):
            run_runtime_checks.run('P0-01')

    def test_missing_new_runtime_checks_cannot_pass_or_update_progress(self):
        before=(self.root/'docs/handoff/progress.json').read_bytes()
        with patch.object(run_runtime_checks,'ROOT',self.root),contextlib.redirect_stdout(io.StringIO()):
            code=run_runtime_checks.run('R0-01')
        report=json.loads((self.root/'.reports/runtime/R0-01.json').read_text(encoding='utf-8'))
        self.assertEqual(code,2)
        self.assertEqual(report['plan_id'],'opencode-app-base-v2')
        self.assertFalse(report['archived_reference'])
        self.assertEqual(report['tests_run'],0)
        self.assertEqual((self.root/'docs/handoff/progress.json').read_bytes(),before)

    def test_historical_plan_requires_explicit_selection_and_has_separate_report(self):
        archive=self.root/'docs/archive/python-host-plan'
        archive.mkdir(parents=True)
        (archive/'work-plan.json').write_text(json.dumps({'tasks':[{'id':'P0-01','test_files':['tests/old.py'],
                                                                  'acceptance_ids':['F01']}]}),encoding='utf-8')
        with patch.object(run_runtime_checks,'ROOT',self.root),contextlib.redirect_stdout(io.StringIO()):
            code=run_runtime_checks.run('P0-01',archived=True)
        self.assertEqual(code,2)
        report=json.loads((self.root/'.reports/runtime/archived-python-host-plan/P0-01.json').read_text(encoding='utf-8'))
        self.assertTrue(report['archived_reference'])
        self.assertFalse((self.root/'.reports/runtime/P0-01.json').exists())

    def test_current_design_validation_is_read_only_for_progress(self):
        path=ROOT/'docs/handoff/progress.json'
        before=hashlib.sha256(path.read_bytes()).hexdigest()
        report=validate_design.validate()
        progress=json.loads(path.read_text(encoding='utf-8'))
        active=progress['module_plan'] if progress.get('active_plan_id')==progress.get('module_plan',{}).get('plan_id') else progress
        recorded=active['runtime_acceptance_completed']
        self.assertEqual(report['plan_id'],active['plan_id'])
        self.assertEqual(report['runtime_acceptance_recorded_completed'],len(recorded))
        self.assertEqual(report['runtime_acceptance_executed'],0)
        self.assertEqual(report['archived_recorded_tests'],49)
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),before)

    def test_file_capability_cannot_be_silently_reenabled_in_plan(self):
        for name in ('scope.json',):
            p=self.root/'docs/architecture'/name
            p.parent.mkdir(parents=True,exist_ok=True)
            data=json.loads((ROOT/'docs/architecture'/name).read_text(encoding='utf-8'))
            data['filesystem']['project_file_tools']=True
            p.write_text(json.dumps(data),encoding='utf-8')
        baseline=self.root/'docs/handoff/dependency-baseline.json'
        baseline.write_bytes((ROOT/'docs/handoff/dependency-baseline.json').read_bytes())
        with self.assertRaisesRegex(AssertionError,'file capability'):
            validate_design.validate(self.root)


if __name__=='__main__':
    unittest.main()
