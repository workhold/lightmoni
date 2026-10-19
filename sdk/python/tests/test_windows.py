import unittest
from lightmoni.windows import copy_windows,window_at,PERIODS
from lightmoni.distribution import Distribution
class WindowsTests(unittest.TestCase):
    def test_boundaries_and_policy_validation(self):
        at=1792382417999000000
        for seconds in PERIODS:
            p=copy_windows({'app':[dict(seconds=seconds,effective_at=0)]})
            start,period=window_at(p,'app',at)
            self.assertEqual(start%(seconds*1000000000),0)
            self.assertLessEqual(start,at)
            self.assertLess(at,start+period*1000000000)
        with self.assertRaises(ValueError): copy_windows({'app':[dict(seconds=20,effective_at=0)]})
    def test_signed_distribution_has_one_total_dense_slot_budget(self):
        d=Distribution(0)
        for value in [1e-200,1e200,-1e-200,-1e200,0]: self.assertTrue(d.observe(value,1<<20))
        p=d.point(1,[])
        self.assertLessEqual(len(p['positive']['bucketCounts'])+len(p['negative']['bucketCounts']),1024)
        self.assertEqual(d.count,5)

    def test_one_effective_period_per_table_and_default(self):
        policies=copy_windows({'fast':[dict(seconds=10,effective_at=0),dict(seconds=60,effective_at=1800000000)],'slow':[dict(seconds=300,effective_at=0)]})
        for table,at,expected in [('fast',1799999999,10),('fast',1800000000,60),('slow',1800000000,300),('default',1800000000,30)]:
            self.assertEqual(window_at(policies,table,at*1000000000)[1],expected)
