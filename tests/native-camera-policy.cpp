#include "../native-camera/media-policy.hpp"
#include <cassert>
#include <initializer_list>

int main()
{
	for (const auto &mode : Dualcast::video_modes) {
		assert(Dualcast::supported_size(mode.width, mode.height));
		for (const auto fps : {15, 24, 25, 30, 50, 60}) {
			const auto interval = 10000000LL / fps;
			assert(Dualcast::supported_interval(interval));
			assert(Dualcast::supported_interval(interval + 1));
		}
	}
	assert(Dualcast::supported_interval(333667)); // 29.97 fps
	assert(!Dualcast::supported_interval(0));
	assert(!Dualcast::supported_interval(166665));
	assert(!Dualcast::supported_interval(666668));
	assert(!Dualcast::supported_size(1919, 1080));
	assert(!Dualcast::supported_size(0, 0));
	assert(!Dualcast::supported_size(65536, 65536));
}
