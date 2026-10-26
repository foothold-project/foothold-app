"""External observation recovers on the same binding; no control requests."""
import asyncio

import pytest

from foothold_agent.ros_bridge.media import MediaRosSource
from test_media import compressed, jpeg, media, wait_frame
from test_phone import h


@pytest.mark.parametrize('media', [True], indirect=True)
def test_external_no_video_recovers_without_rebinding(media):
    async def exercise():
        source = MediaRosSource(media)
        binding, generation = dict(media.binding), media.generation
        source.update_time(binding['epoch'], 10.)
        source.external(compressed(jpeg((320, 240)), 10))
        first = await wait_frame(media, 'external')
        queue = media.subscribe('external')
        try:
            await asyncio.sleep(1.1)
            media.sample()
            status = queue.get_nowait()[1]
            assert status['t'] == 'media.status' and status['state'] == 'NO_VIDEO'
            assert 'external' not in media.latest
            source.update_time(binding['epoch'], 11.)
            source.external(compressed(jpeg((320, 240)), 11))
            second = await wait_frame(media, 'external')
            assert second[1]['seq'] == first[1]['seq'] + 1
            assert second[1]['channel'] == 'external'
            assert second[1]['source'] == 'gazebo_external'
            assert media.binding == binding and media.generation == generation
            assert all(second[1][key] == value for key, value in binding.items())
        finally:
            media.unsubscribe('external', queue)
    asyncio.run(exercise())
