#pragma once
#include <cstdint>

namespace Dualcast {

struct VideoMode {
	int width;
	int height;
};

constexpr VideoMode video_modes[] = {
	{1920, 1080}, {1280, 720}, {960, 540}, {640, 480}, {640, 360},
};
constexpr std::int64_t min_interval = 10000000 / 60;
constexpr std::int64_t max_interval = (10000000 + 14) / 15;

constexpr bool supported_size(int width, int height)
{
	for (const auto &mode : video_modes) {
		if (mode.width == width && mode.height == height)
			return true;
	}
	return false;
}

constexpr bool supported_interval(std::int64_t interval)
{
	return interval >= min_interval && interval <= max_interval;
}

} // namespace Dualcast
