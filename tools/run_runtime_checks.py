"""Run a task's actual unittest files; missing, empty or skipped suites cannot pass."""
from pathlib import Path
import argparse, importlib.util, json, sys, unittest

ROOT=Path(__file__).resolve().parents[1]
if __package__ in {None, ''}:
    sys.path.insert(0, str(ROOT))
from tools.handoff_plan import select_plan

def run(ident, archived=False):
    directory=ROOT/('docs/archive/python-host-plan' if archived else 'docs/handoff')
    plan=(json.loads((directory/'work-plan.json').read_text(encoding='utf-8')) if archived
          else select_plan(ROOT, task_id=ident)[0])
    task=next((t for t in plan['tasks'] if t['id']==ident),None)
    if not task:raise ValueError('Unknown task ID')
    files=[(ROOT/p).resolve() for p in task['test_files']]
    if any(not p.is_relative_to((ROOT/'tests').resolve()) for p in files):raise ValueError('Test path escapes tests directory')
    record={'task':ident,'plan_id':plan.get('plan_id','archived-python-host-plan'),
            'archived_reference':archived,'status':'blocked','tests_run':0,'failures':0,'errors':0,'skipped':0,
            'acceptance_ids':task['acceptance_ids'],'progress_updated':False}
    missing=[str(p.relative_to(ROOT)) for p in files if not p.is_file()]
    if missing:
        record.update(reason='Runtime tests have not been implemented',missing=missing)
        code=2
    else:
        suite=unittest.TestSuite();sys.path.insert(0,str(ROOT))
        try:
            for number,p in enumerate(files):
                name='_handoff_runtime_'+str(number)
                spec=importlib.util.spec_from_file_location(name,p)
                module=importlib.util.module_from_spec(spec);sys.modules[name]=module
                # Compile the current test source explicitly. Timestamp/size
                # bytecode caches must not validate an earlier test revision.
                exec(compile(p.read_bytes(),str(p),'exec'),module.__dict__)
                suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(module))
            if suite.countTestCases()==0:
                record['reason']='No runtime tests discovered';code=2
            else:
                result=unittest.TextTestRunner(verbosity=2).run(suite)
                passed=result.wasSuccessful() and not result.skipped and result.testsRun>0
                record.update(status='passed' if passed else 'failed',tests_run=result.testsRun,
                              failures=len(result.failures),errors=len(result.errors),skipped=len(result.skipped))
                if result.skipped:record['reason']='Skipped required task checks cannot establish completion'
                code=0 if passed else 1
        except Exception as error:
            record.update(status='failed',reason='Runtime tests failed to import or load',error_type=type(error).__name__)
            code=1
    out=ROOT/('.reports/runtime/archived-python-host-plan' if archived else '.reports/runtime');out.mkdir(parents=True,exist_ok=True)
    (out/(ident+'.json')).write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(record,ensure_ascii=False))
    return code

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--task',required=True)
    parser.add_argument('--archived-python-host-plan',action='store_true',help='Explicitly run a historical reference task; does not advance the active plan')
    args=parser.parse_args()
    try:sys.exit(run(args.task,args.archived_python_host_plan))
    except ValueError as error:parser.error(str(error))
