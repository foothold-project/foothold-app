from pydantic import ValidationError
import pytest

from apps.contracts.models import OrgSettings, OrgSettingsPatch, SIM_SETTING_FIELDS


def test_model_overrides_are_sparse_strict_and_patch_only_null():
    fields = {'sim_key_vx': .3, 'lidar_view_m': 20}
    settings = OrgSettings(model_overrides={'start-demo': fields})
    assert settings.model_overrides['start-demo'] == fields
    with pytest.raises(ValidationError, match='go2-demo'):
        OrgSettings(model_overrides={'go2-demo': {'real_no_fast_server_drive': True}})
    assert OrgSettings().model_overrides == {}
    assert OrgSettingsPatch().model_dump(exclude_unset=True) == {}
    assert OrgSettingsPatch(model_overrides={'start-demo': {'sim_key_vx': None}}).model_dump(
        exclude_unset=True) == {'model_overrides': {'start-demo': {'sim_key_vx': None}}}
    for value in (None, [], {'start-demo': {'sim_key_vx': None}}, {'start-demo': {'sim_key_vx': float('nan')}}):
        with pytest.raises(ValidationError):
            OrgSettings(model_overrides=value)


def test_each_model_uses_common_field_envelope_and_merged_order():
    assert len(SIM_SETTING_FIELDS) == 9
    for model in ('nvidia-demo', 'ame2-demo', 'start-demo'):
        OrgSettings(model_overrides={model: {'sim_max_vx': .5, 'sim_key_vx': .4}})
        with pytest.raises(ValidationError, match=model):
            OrgSettings(model_overrides={model: {'sim_max_vx': .5}})
        for field, value in [('sim_max_vx', 1.51), ('sim_max_vy', .51),
                             ('sim_max_wz', 1.21), ('sim_runner_vx', 1.51), ('sim_runner_wz', 1.01)]:
            with pytest.raises(ValidationError, match=model):
                OrgSettingsPatch(model_overrides={model: {field: value}})
